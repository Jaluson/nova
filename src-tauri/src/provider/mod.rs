pub mod adoptium;
pub mod corretto;
pub mod tsinghua;
pub mod zulu;

use crate::error::AppError;
use std::sync::OnceLock;

/// Shared HTTP client with timeout and connection pooling.
/// Created once and reused across all provider requests.
static HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

pub fn http_client() -> &'static reqwest::blocking::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// Metadata for a remote JDK version available for download
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RemoteJdk {
    pub version: String,
    pub url: String,
    pub checksum: Option<String>,
    /// 文件大小（字节），如果无法获取则为 None
    pub size: Option<u64>,
}

/// Trait for JDK download providers (Corretto, Adoptium, Zulu)
pub trait JdkProvider: Send + Sync {
    /// List available versions, optionally filtered by major version
    fn list_versions(&self, major: Option<u32>) -> Result<Vec<RemoteJdk>, AppError>;

    /// Resolve a specific version string to a download URL
    fn resolve(&self, version: &str) -> Result<RemoteJdk, AppError>;
}

/// 通过 HEAD 请求获取 URL 的 Content-Length（暂未使用，保留备用）
#[allow(dead_code)]
fn fetch_content_length(url: &str) -> Option<u64> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?
        .head(url)
        .send()
        .ok()
        .and_then(|resp| {
            resp.headers()
                .get("content-length")?
                .to_str()
                .ok()?
                .parse()
                .ok()
        })
}
