//! The guarded exchange transport: allowlist enforcement and request signing.
//!
//! This module is the reason Misal can claim to be read-only.
//!
//! CoinDCX issues one class of API key with full trade authority. There is no read-only option,
//! no permission model, and no endpoint that reports a key's scope - a key that authenticates is
//! a full-access key. CoinSwitch is the same. So a safety story resting on key scoping is one we
//! could not tell for half the exchanges we support, and the guarantee is inverted instead: each
//! adapter declares the exact set of requests it may make, and nothing else can leave this
//! process. Binance's `POST /api/v3/order` is unreachable from Misal not because the key forbids
//! it but because no code path can express it.
//!
//! Enforcement lives here rather than only in TypeScript because this is the layer that owns the
//! socket and the secret. The TypeScript guard mirrors it so a contributor gets a stack trace
//! pointing at their adapter, but the check that counts is this one.
//!
//! Three properties are asserted by the tests below:
//!
//! 1. Every allowlist is validated when the session is built, and every concrete path is
//!    classified again at send time. A trailing wildcard is otherwise a hole - `/api/v3/*` admits
//!    `/api/v3/order` while looking perfectly innocent in review.
//! 2. The bytes signed are the bytes transmitted. Signing one serialisation and sending another
//!    is the failure that breaks most CoinDCX clients in the wild, and it is invisible to a test
//!    that only exercises the signing function in isolation.
//! 3. The secret is zeroised once signing is done.

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GuardError {
    #[error("{adapter} refused {method} {path}: {reason}")]
    Refused {
        adapter: String,
        method: Method,
        path: String,
        reason: String,
    },

    #[error("{adapter} allowlist entry {method} {pattern} is not acceptable: {reason}")]
    BadAllowlistEntry {
        adapter: String,
        method: Method,
        pattern: String,
        reason: String,
    },
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
}

impl std::fmt::Display for Method {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Method::Get => "GET",
            Method::Post => "POST",
        })
    }
}

/// One permitted request. There is no field here that could carry a body, a header or a host of
/// the caller's choosing: an allowlist entry describes a method and a path, and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AllowedRequest {
    pub method: Method,
    /// An exact path, or a path with a single trailing `/*`.
    pub path_pattern: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SigningScheme {
    None,
    /// HMAC-SHA256 over the exact query string, appended as a trailing `signature` parameter.
    BinanceQuery,
    /// HMAC-SHA256 over the exact serialised body, sent in `X-AUTH-SIGNATURE`.
    CoindcxBody,
}

/// A request as the adapter expressed it.
///
/// `query` and `body` arrive already serialised, as strings. That is deliberate: the exchange
/// re-reads the literal bytes it was sent, so there must be exactly one serialisation and it must
/// happen before anything here sees it.
#[derive(Debug, Clone)]
pub struct OutboundRequest {
    pub method: Method,
    pub base_url: String,
    pub path: String,
    /// Without a leading `?`. Empty when there is none.
    pub query: String,
    pub body: Option<String>,
    pub signing: SigningScheme,
    pub api_key: String,
    /// Explicit and browser-like. CoinDCX's edge answers a default library agent with a
    /// non-JSON 403 that looks exactly like an auth failure.
    pub user_agent: String,
}

/// A request that has passed the guard and been signed. The only thing a transport can send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// Exactly what the HMAC was computed over, kept so the byte-identity test can recompute it
    /// from the transmitted request rather than from an intermediate the caller kept around.
    pub signed_payload: String,
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/// Path segments naming an operation that changes state.
///
/// Matched per segment rather than as substrings. A substring match on `withdraw` would reject
/// `/sapi/v1/capital/withdraw/history`, and on `order` would reject
/// `/exchange/v1/orders/trade_history` - both read-only endpoints we need.
const MUTATING_SEGMENTS: &[&str] = &[
    "order",
    "orders",
    "openorders",
    "orderlist",
    "oco",
    "cancel",
    "cancelreplace",
    "create",
    "new",
    "delete",
    "update",
    "edit",
    "buy",
    "sell",
    "withdraw",
    "withdrawal",
    "withdrawals",
    "apply",
    "transfer",
    "transfers",
    "convert",
    "borrow",
    "repay",
    "loan",
    "redeem",
    "subscribe",
    "purchase",
    "lend",
    "stake",
    "unstake",
    "send",
    "pay",
    "enable",
    "disable",
];

/// Terminal segments that turn a mutating noun into a read of its history.
///
/// Only the last segment is consulted: `/sapi/v1/capital/withdraw/history` reads withdrawals and
/// `/sapi/v1/capital/withdraw/apply` performs one, and the whole difference is in the tail.
const READ_TERMINALS: &[&str] = &[
    "history",
    "hisrec",
    "trade_history",
    "tradehistory",
    "list",
    "status",
    "info",
    "detail",
    "details",
    "query",
    "all",
    "records",
    "log",
    "logs",
];

/// Why a path is mutating, or `None` when it is not.
pub fn mutation_reason(path: &str) -> Option<String> {
    let segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect();

    // A wildcard tail cannot be shown to be read-only, so it never earns the exemption.
    let read_only_tail = segments
        .last()
        .map(|last| last != "*" && READ_TERMINALS.contains(&last.as_str()))
        .unwrap_or(false);

    if read_only_tail {
        return None;
    }

    // Matching whole segments is not enough. The well-formed-path grammar permits '.', '_' and
    // '-', so `order.`, `order.json`, `_order` and `order-v2` all differ from `order` as strings
    // while naming the same operation. A contributed adapter could put any of them on its
    // allowlist and pass review. Tokenising on that punctuation closes the family, not one case.
    for segment in &segments {
        for token in segment.split(['.', '_', '-']).filter(|t| !t.is_empty()) {
            if MUTATING_SEGMENTS.contains(&token) {
                return Some(if token == segment {
                    format!("path segment '{segment}' names a mutating operation")
                } else {
                    format!(
                        "path segment '{segment}' contains '{token}', which names a mutating operation"
                    )
                });
            }
        }
    }

    None
}

pub fn is_mutating_path(path: &str) -> bool {
    mutation_reason(path).is_some()
}

/// Paths are plain, unescaped, absolute and dot-free.
///
/// Without this an allowlist is decoration: `/api/v3/myTrades/../order` matches nothing on the
/// list but resolves to the order endpoint at the server, and `/api/v3/myTrades?x=1#/order` hides
/// a query string inside what the guard reads as a path. Both exchanges use nothing outside
/// `[A-Za-z0-9._-]`, so refusing everything else costs nothing.
fn path_is_well_formed(path: &str, allow_wildcard: bool) -> bool {
    if !path.starts_with('/') || path.contains("..") || path.ends_with('/') {
        return false;
    }
    let mut segments = path.split('/').skip(1).peekable();
    let mut any = false;
    while let Some(segment) = segments.next() {
        any = true;
        if segment.is_empty() {
            return false;
        }
        let last = segments.peek().is_none();
        if allow_wildcard && last && segment == "*" {
            continue;
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return false;
        }
    }
    any
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/// A validated allowlist, bound to one adapter.
///
/// Constructing it is the only way to get a `SignedRequest`, and construction fails if the
/// allowlist contains anything mutating. An adapter with a bad allowlist therefore cannot make
/// any request at all, rather than making the safe-looking ones and one dangerous one.
#[derive(Debug, Clone)]
pub struct Session {
    adapter: String,
    allowlist: Vec<AllowedRequest>,
}

impl Session {
    pub fn new(adapter: &str, allowlist: Vec<AllowedRequest>) -> Result<Self, GuardError> {
        for entry in &allowlist {
            if !path_is_well_formed(&entry.path_pattern, true) {
                return Err(GuardError::BadAllowlistEntry {
                    adapter: adapter.to_string(),
                    method: entry.method,
                    pattern: entry.path_pattern.clone(),
                    reason: "malformed path".to_string(),
                });
            }
            if let Some(reason) = mutation_reason(&entry.path_pattern) {
                return Err(GuardError::BadAllowlistEntry {
                    adapter: adapter.to_string(),
                    method: entry.method,
                    pattern: entry.path_pattern.clone(),
                    reason,
                });
            }
        }
        Ok(Self {
            adapter: adapter.to_string(),
            allowlist,
        })
    }

    fn permits(&self, method: Method, path: &str) -> bool {
        self.allowlist
            .iter()
            .any(|entry| entry.method == method && pattern_matches(&entry.path_pattern, path))
    }

    /// The gate. Both checks run, and the second is the one that closes the wildcard hole.
    pub fn authorise(&self, method: Method, path: &str) -> Result<(), GuardError> {
        let refuse = |reason: &str| GuardError::Refused {
            adapter: self.adapter.clone(),
            method,
            path: path.to_string(),
            reason: reason.to_string(),
        };

        if !path_is_well_formed(path, false) {
            return Err(refuse("malformed path"));
        }
        if let Some(reason) = mutation_reason(path) {
            return Err(refuse(&reason));
        }
        if !self.permits(method, path) {
            return Err(refuse("not on the request allowlist"));
        }
        Ok(())
    }

    /// Authorise, then sign. There is no path to a `SignedRequest` that skips the authorisation.
    pub fn prepare(
        &self,
        request: OutboundRequest,
        secret: &Secret,
    ) -> Result<SignedRequest, GuardError> {
        self.authorise(request.method, &request.path)?;
        Ok(sign(request, secret))
    }
}

fn pattern_matches(pattern: &str, path: &str) -> bool {
    match pattern.strip_suffix("/*") {
        Some(prefix) => path.starts_with(prefix) && path.len() > prefix.len() + 1,
        None => pattern == path,
    }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/// An API secret, zeroised when it goes out of scope.
///
/// Read from the keychain for the duration of one signing operation and no longer. Nothing here
/// implements `Debug` or `Display`, so it cannot reach a log line by accident.
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(value: impl Into<Vec<u8>>) -> Self {
        Self(value.into())
    }

    fn bytes(&self) -> &[u8] {
        &self.0
    }

    /// Overwrite the key material in place.
    ///
    /// Volatile writes, so the compiler cannot elide an overwrite of a buffer that is about to
    /// be freed and never read again.
    fn zeroise(&mut self) {
        for byte in self.0.iter_mut() {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::fence(std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.zeroise();
    }
}

/// Sign a request, moving the payload into the result.
///
/// The payload is moved rather than copied and re-derived, which is what makes "the bytes signed
/// are the bytes transmitted" a property of the type rather than a promise in a comment. There is
/// no object here that a later stage could re-encode.
fn sign(request: OutboundRequest, secret: &Secret) -> SignedRequest {
    let mut headers = vec![("User-Agent".to_string(), request.user_agent.clone())];

    match request.signing {
        SigningScheme::None => SignedRequest {
            method: request.method,
            url: join(&request.base_url, &request.path, &request.query),
            headers,
            body: request.body,
            signed_payload: String::new(),
        },

        SigningScheme::BinanceQuery => {
            // Binance re-reads the literal query string it was sent, so parameter order is free
            // but the string must not be rebuilt after signing.
            let payload = request.query;
            let signature = hmac_sha256_hex(secret.bytes(), payload.as_bytes());
            headers.push(("X-MBX-APIKEY".to_string(), request.api_key));
            let query = format!("{payload}&signature={signature}");
            SignedRequest {
                method: request.method,
                url: join(&request.base_url, &request.path, &query),
                headers,
                body: request.body,
                signed_payload: payload,
            }
        }

        SigningScheme::CoindcxBody => {
            // CoinDCX HMACs the body with no canonicalisation at all - no key sorting, no
            // whitespace normalisation. Whatever arrived is signed and sent, unchanged.
            let payload = request.body.unwrap_or_default();
            let signature = hmac_sha256_hex(secret.bytes(), payload.as_bytes());
            headers.push(("X-AUTH-APIKEY".to_string(), request.api_key));
            headers.push(("X-AUTH-SIGNATURE".to_string(), signature));
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
            SignedRequest {
                method: request.method,
                url: join(&request.base_url, &request.path, &request.query),
                headers,
                body: Some(payload.clone()),
                signed_payload: payload,
            }
        }
    }
}

fn join(base_url: &str, path: &str, query: &str) -> String {
    if query.is_empty() {
        format!("{base_url}{path}")
    } else {
        format!("{base_url}{path}?{query}")
    }
}

/// HMAC-SHA256, hex encoded.
///
/// Implemented over `sha2` rather than pulling in another crate: it is twenty lines of a
/// well-specified construction, and the RFC 4231 vectors below check it.
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK: usize = 64;

    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        inner_pad[i] ^= block[i];
        outer_pad[i] ^= block[i];
    }

    let inner = Sha256::new()
        .chain_update(inner_pad)
        .chain_update(message)
        .finalize();
    let outer = Sha256::new()
        .chain_update(outer_pad)
        .chain_update(inner)
        .finalize();

    // The padded key material is on the stack; clear it rather than leaving it for whatever
    // reuses the frame.
    block.fill(0);
    inner_pad.fill(0);
    outer_pad.fill(0);

    hex::encode(outer)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Raw text, never parsed here. CoinDCX returns JSON floats that a parser would destroy
    /// before the adapter ever saw them.
    pub text: String,
}

/// The socket-owning layer.
///
/// A trait rather than a concrete client so that the guard and the signing above can be tested
/// without one, and so the test build cannot construct a real one. Wiring an HTTP client to it,
/// and exposing the Tauri command that drives it, is the remaining integration step; nothing in
/// this module needs to change for it.
pub trait Transport {
    fn send(&self, request: &SignedRequest) -> Result<HttpResponse, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = include_str!("../../tests/fixtures/adapters/mutating-paths.json");

    fn table() -> serde_json::Value {
        serde_json::from_str(FIXTURES).expect("path table is not valid JSON")
    }

    fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
        value[key]
            .as_array()
            .unwrap_or_else(|| panic!("{key} is not an array"))
            .iter()
            .map(|v| v.as_str().expect("not a string").to_string())
            .collect()
    }

    /// The same table drives the TypeScript guard's tests. Neither implementation can drift
    /// without failing on one side or the other.
    #[test]
    fn agrees_with_the_shared_path_table() {
        for path in strings(&table(), "mutating") {
            assert!(
                is_mutating_path(&path),
                "{path} was not classified as mutating"
            );
        }
        for path in strings(&table(), "readOnly") {
            assert!(
                !is_mutating_path(&path),
                "{path} was wrongly classified as mutating: {:?}",
                mutation_reason(&path)
            );
        }
    }

    #[test]
    fn reading_withdrawals_is_not_performing_one() {
        assert!(!is_mutating_path("/sapi/v1/capital/withdraw/history"));
        assert!(is_mutating_path("/sapi/v1/capital/withdraw/apply"));
    }

    fn session(patterns: &[(Method, &str)]) -> Session {
        Session::new(
            "test",
            patterns
                .iter()
                .map(|(method, pattern)| AllowedRequest {
                    method: *method,
                    path_pattern: (*pattern).to_string(),
                })
                .collect(),
        )
        .expect("allowlist rejected")
    }

    #[test]
    fn a_mutating_allowlist_entry_prevents_the_session_existing_at_all() {
        let result = Session::new(
            "rogue",
            vec![AllowedRequest {
                method: Method::Post,
                path_pattern: "/api/v3/order".to_string(),
            }],
        );
        assert!(matches!(result, Err(GuardError::BadAllowlistEntry { .. })));
    }

    #[test]
    fn a_wildcard_does_not_admit_a_mutating_path_under_it() {
        // The hole an allowlist alone cannot close: '/api/v3/*' looks innocent in review and
        // would otherwise admit '/api/v3/order'.
        let wildcard = table()["wildcard"].clone();
        let pattern = wildcard["pattern"].as_str().unwrap();
        let refused = wildcard["refused"].as_str().unwrap();
        let allowed = wildcard["allowed"].as_str().unwrap();

        let session = session(&[(Method::Get, pattern)]);
        assert!(session.authorise(Method::Get, refused).is_err());
        assert!(session.authorise(Method::Get, allowed).is_ok());
    }

    #[test]
    fn refuses_a_path_that_is_not_listed_or_uses_the_wrong_method() {
        let session = session(&[(Method::Get, "/api/v3/myTrades")]);
        assert!(session.authorise(Method::Get, "/api/v3/myTrades").is_ok());
        assert!(session.authorise(Method::Get, "/api/v3/account").is_err());
        assert!(session.authorise(Method::Post, "/api/v3/myTrades").is_err());
    }

    #[test]
    fn refuses_a_traversal_that_the_server_would_resolve_to_an_order() {
        let session = session(&[(Method::Get, "/api/v3/myTrades")]);
        for path in [
            "/api/v3/myTrades/../order",
            "/api/v3/myTrades?symbol=X",
            "/api/v3/myTrades#/order",
            "//api/v3/order",
            "api/v3/myTrades",
        ] {
            assert!(
                session.authorise(Method::Get, path).is_err(),
                "{path} was allowed"
            );
        }
    }

    // RFC 4231 test vectors. Public, non-functional values by construction.
    #[test]
    fn hmac_matches_the_published_vectors() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // A key longer than the 64-byte block, which is hashed first.
        assert_eq!(
            hmac_sha256_hex(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    fn fake_secret() -> Secret {
        // Not a key. Sixty-four characters of a fixed pattern, so nothing resembling a real
        // secret ever appears in this repository.
        Secret::new("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    }

    #[test]
    fn coindcx_transmits_exactly_the_bytes_it_signed() {
        // The failure this test exists for: serialising once for the signature and letting an
        // HTTP client re-serialise the object for the wire. The bytes differ, the signature is
        // permanently wrong, and every request comes back 401.
        let session = session(&[(Method::Post, "/exchange/v1/orders/trade_history")]);
        let body = r#"{"limit":500,"sort":"asc","from_id":89,"timestamp":1786528800000}"#;

        let signed = session
            .prepare(
                OutboundRequest {
                    method: Method::Post,
                    base_url: "https://api.coindcx.com".to_string(),
                    path: "/exchange/v1/orders/trade_history".to_string(),
                    query: String::new(),
                    body: Some(body.to_string()),
                    signing: SigningScheme::CoindcxBody,
                    api_key: "public-identifier".to_string(),
                    user_agent: "Misal/0.1".to_string(),
                },
                &fake_secret(),
            )
            .expect("refused");

        let transmitted = signed.body.as_deref().expect("no body");
        assert_eq!(transmitted, signed.signed_payload);
        assert_eq!(transmitted, body);

        // Recomputed from what will actually go on the wire, not from anything the caller kept.
        let header = signed
            .headers
            .iter()
            .find(|(name, _)| name == "X-AUTH-SIGNATURE")
            .map(|(_, value)| value.clone())
            .expect("no signature header");
        assert_eq!(
            header,
            hmac_sha256_hex(fake_secret().bytes(), transmitted.as_bytes())
        );

        // The query string is not part of the signature, and nothing was smuggled into it.
        assert!(!signed.url.contains('?'));
    }

    #[test]
    fn binance_transmits_exactly_the_query_string_it_signed() {
        let session = session(&[(Method::Get, "/api/v3/myTrades")]);
        let query = "symbol=BTCUSDT&fromId=0&limit=1000&recvWindow=10000&timestamp=1786528800000";

        let signed = session
            .prepare(
                OutboundRequest {
                    method: Method::Get,
                    base_url: "https://api.binance.com".to_string(),
                    path: "/api/v3/myTrades".to_string(),
                    query: query.to_string(),
                    body: None,
                    signing: SigningScheme::BinanceQuery,
                    api_key: "public-identifier".to_string(),
                    user_agent: "Misal/0.1".to_string(),
                },
                &fake_secret(),
            )
            .expect("refused");

        let signature = hmac_sha256_hex(fake_secret().bytes(), query.as_bytes());
        assert_eq!(signed.signed_payload, query);
        assert_eq!(
            signed.url,
            format!("https://api.binance.com/api/v3/myTrades?{query}&signature={signature}")
        );
        // The signed prefix is transmitted verbatim: parameter order is free, but the string is
        // never rebuilt between signing and sending.
        let transmitted_query = signed.url.split_once('?').expect("no query").1;
        assert!(transmitted_query.starts_with(query));
        assert_eq!(
            &transmitted_query[..query.len()],
            signed.signed_payload.as_str()
        );
        assert!(signed
            .headers
            .iter()
            .any(|(name, value)| name == "X-MBX-APIKEY" && value == "public-identifier"));
    }

    #[test]
    fn signing_carries_an_explicit_user_agent() {
        // CoinDCX sits behind Cloudflare, which answers a default library agent with a non-JSON
        // 403 that reads exactly like an auth failure.
        let session = session(&[(Method::Post, "/exchange/v1/users/balances")]);
        let signed = session
            .prepare(
                OutboundRequest {
                    method: Method::Post,
                    base_url: "https://api.coindcx.com".to_string(),
                    path: "/exchange/v1/users/balances".to_string(),
                    query: String::new(),
                    body: Some(r#"{"timestamp":1786528800000}"#.to_string()),
                    signing: SigningScheme::CoindcxBody,
                    api_key: "public-identifier".to_string(),
                    user_agent: "Misal/0.1".to_string(),
                },
                &fake_secret(),
            )
            .expect("refused");
        assert!(signed
            .headers
            .iter()
            .any(|(name, value)| name == "User-Agent" && value == "Misal/0.1"));
    }

    #[test]
    fn a_refused_request_is_never_signed() {
        let session = session(&[(Method::Get, "/api/v3/myTrades")]);
        let result = session.prepare(
            OutboundRequest {
                method: Method::Post,
                base_url: "https://api.binance.com".to_string(),
                path: "/api/v3/order".to_string(),
                query: "symbol=BTCUSDT&side=BUY".to_string(),
                body: None,
                signing: SigningScheme::BinanceQuery,
                api_key: "public-identifier".to_string(),
                user_agent: "Misal/0.1".to_string(),
            },
            &fake_secret(),
        );
        assert!(matches!(result, Err(GuardError::Refused { .. })));
    }

    /// `Drop` is one line calling `zeroise`, so testing the overwrite itself is the whole of it.
    /// Reading the buffer after the drop would mean reading freed memory, which is undefined
    /// behaviour and would make this test less trustworthy than the code it checks.
    #[test]
    fn the_secret_is_overwritten_rather_than_merely_released() {
        let mut secret = Secret::new("sensitive-material");
        assert!(secret.bytes().iter().any(|b| *b != 0));
        secret.zeroise();
        assert!(secret.bytes().iter().all(|b| *b == 0));
    }
}
