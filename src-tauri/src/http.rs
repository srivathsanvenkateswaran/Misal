//! The socket-owning layer.
//!
//! Two separate doors out of the process, deliberately not one:
//!
//!   * `ReqwestTransport` carries exchange requests, and every one passes `Session::authorise`
//!     first. CoinDCX issues no read-only API keys - every key can trade and withdraw - so this
//!     guard is the only thing between a bug and someone's funds.
//!   * `fetch_market_data` carries price and rate lookups, which are unauthenticated GETs to a
//!     fixed set of hosts.
//!
//! Neither is a general HTTP client, and there is deliberately no command that accepts an
//! arbitrary URL. A local-first application that will happily fetch anything the frontend names
//! is one XSS away from being an exfiltration tool, and the whole premise here is that data does
//! not leave the machine except where the user asked it to.

use crate::error::{MisalError, Result};
use crate::exchange_guard::{HttpResponse, Method, SignedRequest, Transport};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Hosts the market-data path may reach, and the path prefix allowed on each.
///
/// An explicit table rather than a scheme check. Restricting to HTTPS would still allow any host
/// on the internet; naming them means a compromised frontend cannot redirect a fetch somewhere
/// that logs what a user holds.
/// Public so `settings.rs` can generate the "what leaves this machine" disclosure from the list the
/// socket layer actually enforces. A disclosure written separately would drift the first time a
/// host was added here.
pub const MARKET_DATA_HOSTS: &[(&str, &str)] = &[
    // AMFI's daily NAV file. Keyless and official, which is why mutual funds price before the
    // user has entered any provider key.
    ("portal.amfiindia.com", "/spages/"),
    ("www.amfiindia.com", "/spages/"),
    // Yahoo's unofficial quote endpoints. The only free source covering NSE and BSE; unsupported
    // and liable to change without notice, which is why PriceProvider is pluggable.
    ("query1.finance.yahoo.com", "/v8/finance/"),
    ("query2.finance.yahoo.com", "/v8/finance/"),
    // Twelve Data, for users who bring a key and want a supported provider.
    ("api.twelvedata.com", "/"),
    // CoinGecko, for crypto spot prices.
    ("api.coingecko.com", "/api/v3/"),
];

const TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = concat!("Misal/", env!("CARGO_PKG_VERSION"));

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        // Redirects are refused rather than followed. A followed redirect leaves the host
        // allowlist behind - the check above would pass on the first hop and be irrelevant on the
        // second, which is precisely how an allowlist gets bypassed in practice.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| MisalError::Other(format!("could not build HTTP client: {e}")))
}

/// The real transport. Constructed only where a `Session` has already authorised the request.
pub struct ReqwestTransport {
    inner: reqwest::blocking::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self> {
        Ok(Self { inner: client()? })
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, request: &SignedRequest) -> std::result::Result<HttpResponse, String> {
        // The guard models only GET and POST. There is no DELETE arm to write, which is itself a
        // safety property: a verb that is mutating by definition cannot be expressed at all.
        let method = match request.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
        };

        let mut builder = self.inner.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            // The exact bytes the signature was computed over. Re-serialising here is the failure
            // that breaks most CoinDCX clients: the signature covers one serialisation and the
            // wire carries another.
            builder = builder.body(body.clone());
        }

        let response = builder.send().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
            .collect();
        // Raw text, never parsed here. CoinDCX returns JSON floats that a parser would round
        // before the adapter ever saw them.
        let text = response.text().map_err(|e| e.to_string())?;

        Ok(HttpResponse {
            status,
            headers,
            text,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDataRequest {
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDataResponse {
    pub status: u16,
    /// Raw body. Parsing happens in TypeScript, where the decimal handling lives.
    pub text: String,
}

/// Is this URL one of the market-data endpoints, on an allowlisted host and path prefix?
pub fn market_data_url_is_allowed(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    // Credentials in a URL would let a caller smuggle a different authority past a host check
    // in some parsers; refuse them outright rather than reason about it.
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    MARKET_DATA_HOSTS
        .iter()
        .any(|(allowed_host, prefix)| host == *allowed_host && url.path().starts_with(prefix))
}

/// Fetch a price or exchange-rate document.
///
/// Unauthenticated, GET only, and confined to `MARKET_DATA_HOSTS`. No API key ever travels this
/// path: a keyed provider signs its request through the exchange transport instead, so a secret
/// cannot leak into a URL that ends up in a log.
#[tauri::command]
pub async fn fetch_market_data(request: MarketDataRequest) -> Result<MarketDataResponse> {
    if !market_data_url_is_allowed(&request.url) {
        return Err(MisalError::Other(format!(
            "refused: {} is not an allowlisted market-data endpoint",
            request.url
        )));
    }

    // Blocking client on the blocking pool, so a slow or hung endpoint cannot stall the UI.
    tauri::async_runtime::spawn_blocking(move || {
        let response = client()?
            .get(&request.url)
            .send()
            .map_err(|e| MisalError::Other(format!("request failed: {e}")))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .map_err(|e| MisalError::Other(format!("could not read response: {e}")))?;
        Ok(MarketDataResponse { status, text })
    })
    .await
    .map_err(|e| MisalError::Other(format!("fetch task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_market_data_endpoints_we_actually_use() {
        assert!(market_data_url_is_allowed(
            "https://portal.amfiindia.com/spages/NAVAll.txt"
        ));
        assert!(market_data_url_is_allowed(
            "https://query1.finance.yahoo.com/v8/finance/chart/INFY.NS"
        ));
        assert!(market_data_url_is_allowed(
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin"
        ));
    }

    #[test]
    fn refuses_any_host_not_on_the_list() {
        assert!(!market_data_url_is_allowed("https://evil.example/whatever"));
        assert!(!market_data_url_is_allowed("https://google.com/"));
    }

    #[test]
    fn refuses_a_lookalike_host() {
        // Suffix matching would admit all of these. The check is equality.
        assert!(!market_data_url_is_allowed(
            "https://portal.amfiindia.com.evil.example/spages/NAVAll.txt"
        ));
        assert!(!market_data_url_is_allowed(
            "https://evilportal.amfiindia.com/spages/NAVAll.txt"
        ));
        assert!(!market_data_url_is_allowed(
            "https://query1.finance.yahoo.com.attacker.net/v8/finance/chart/X"
        ));
    }

    #[test]
    fn refuses_an_allowed_host_outside_its_path_prefix() {
        // Yahoo hosts plenty besides the quote API; only the quote paths are in scope.
        assert!(!market_data_url_is_allowed(
            "https://query1.finance.yahoo.com/v7/finance/download/INFY.NS"
        ));
        assert!(!market_data_url_is_allowed(
            "https://portal.amfiindia.com/admin/login"
        ));
    }

    #[test]
    fn refuses_plaintext_http() {
        assert!(!market_data_url_is_allowed(
            "http://portal.amfiindia.com/spages/NAVAll.txt"
        ));
    }

    #[test]
    fn refuses_embedded_credentials() {
        assert!(!market_data_url_is_allowed(
            "https://user:pass@portal.amfiindia.com/spages/NAVAll.txt"
        ));
        // The classic disguise: the real host is after the '@'.
        assert!(!market_data_url_is_allowed(
            "https://portal.amfiindia.com@evil.example/spages/NAVAll.txt"
        ));
    }

    #[test]
    fn refuses_a_path_that_climbs_out_of_its_prefix() {
        // reqwest normalises `..` before we see the path, so this asserts the normalised result
        // is judged rather than the raw string.
        assert!(!market_data_url_is_allowed(
            "https://portal.amfiindia.com/spages/../admin/login"
        ));
    }
}
