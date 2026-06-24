use thiserror::Error;

/// Application-wide error type
#[derive(Error, Debug)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Config error: {0}")]
    Config(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Symlink error: {0}")]
    Symlink(String),

    #[error("JDK not found: {0}")]
    JdkNotFound(String),

    #[error("JDK already installed: {0}")]
    JdkAlreadyInstalled(String),

    #[error("Maven not found: {0}")]
    MavenNotFound(String),

    #[error("Maven already installed: {0}")]
    MavenAlreadyInstalled(String),

    #[error("No JDK is currently active")]
    NoActiveJdk,

    #[error("Download checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("Extraction error: {0}")]
    Extraction(String),

    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Setup not completed")]
    SetupRequired,
}

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
