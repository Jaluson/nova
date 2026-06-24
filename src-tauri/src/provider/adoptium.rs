use crate::error::AppError;
use crate::provider::{JdkProvider, RemoteJdk};
use std::sync::mpsc;

/// Eclipse Adoptium (Temurin) JDK provider
pub struct AdoptiumProvider;

impl JdkProvider for AdoptiumProvider {
    fn list_versions(&self, major: Option<u32>) -> Result<Vec<RemoteJdk>, AppError> {
        let Some(major) = major else {
            let releases = available_releases()?;
            let (tx, rx) = mpsc::channel();

            std::thread::scope(|s| {
                for major in releases {
                    let tx = tx.clone();
                    s.spawn(move || {
                        let result = fetch_single_major(major);
                        let _ = tx.send(result);
                    });
                }
                drop(tx);
            });

            let mut results: Vec<RemoteJdk> =
                rx.into_iter().filter_map(|r| r.ok()).flatten().collect();

            // Sort by version descending
            results.sort_by(|a, b| b.version.cmp(&a.version));
            return Ok(results);
        };

        fetch_single_major(major)
    }

    fn resolve(&self, version: &str) -> Result<RemoteJdk, AppError> {
        let parts: Vec<&str> = version.split('.').collect();
        let major: u32 = parts
            .first()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::Provider(format!("invalid version: {version}")))?;

        let versions = self.list_versions(Some(major))?;

        // Exact match
        if let Some(exact) = versions.iter().find(|v| v.version == version) {
            return Ok(exact.clone());
        }

        // Return latest for this major
        versions.into_iter().next().ok_or_else(|| {
            AppError::Provider(format!("no Adoptium JDK found for version {version}"))
        })
    }
}

fn available_releases() -> Result<Vec<u32>, AppError> {
    let client = crate::provider::http_client();
    let resp = client
        .get("https://api.adoptium.net/v3/info/available_releases")
        .send()
        .map_err(|e| AppError::Network(e))?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    let json: serde_json::Value = resp
        .json()
        .map_err(|e| AppError::Provider(format!("adoptium releases parse error: {e}")))?;

    let releases = json
        .get("available_releases")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_u64())
        .map(|v| v as u32)
        .collect();

    Ok(releases)
}

/// Fetch JDK versions for a single major version
fn fetch_single_major(major: u32) -> Result<Vec<RemoteJdk>, AppError> {
    let client = crate::provider::http_client();
    let url = format!(
        "https://api.adoptium.net/v3/assets/latest/{}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse",
        major
    );

    let resp = client.get(&url).send().map_err(|e| AppError::Network(e))?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    let json: Vec<serde_json::Value> = resp
        .json()
        .map_err(|e| AppError::Provider(format!("adoptium parse error: {e}")))?;

    let mut results = Vec::new();

    for item in &json {
        let version = item
            .get("version")
            .and_then(|v| v.get("semver"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let pkg = item.get("binary").and_then(|b| b.get("package"));
        let download_url = pkg
            .and_then(|p| p.get("link"))
            .and_then(|l| l.as_str())
            .unwrap_or("")
            .to_string();

        let checksum = pkg
            .and_then(|p| p.get("checksum"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let size = pkg.and_then(|p| p.get("size")).and_then(|s| s.as_u64());

        if !version.is_empty() && !download_url.is_empty() {
            results.push(RemoteJdk {
                version: version.to_string(),
                url: download_url,
                checksum,
                size,
            });
        }
    }

    Ok(results)
}
