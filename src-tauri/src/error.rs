use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum MisalError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("keychain unavailable: {0}")]
    Keychain(#[from] keyring::Error),

    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),

    #[error("could not determine a data directory for this platform")]
    NoDataDir,

    /// The stored database key is not 32 bytes of hex. Refusing to continue rather than
    /// re-keying, because generating a fresh key would render an existing database unreadable.
    #[error("stored database key is malformed; refusing to open the database")]
    MalformedKey,

    #[error("migration {version} ({name}) failed: {source}")]
    Migration {
        version: i64,
        name: String,
        #[source]
        source: rusqlite::Error,
    },

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, MisalError>;

/// Errors cross the IPC boundary as plain strings. Deliberately lossy: the frontend gets a
/// message it can display, never a structure it could branch on and mishandle.
impl Serialize for MisalError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
