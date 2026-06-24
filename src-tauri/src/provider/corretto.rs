use crate::error::AppError;
use crate::provider::{JdkProvider, RemoteJdk};

/// Amazon Corretto JDK provider
///
/// Uses the master JSON index from:
/// https://raw.githubusercontent.com/corretto/corretto-downloads/main/latest_links/indexmap_with_checksum.json
///
/// Structure: index["windows"]["x64"]["jdk"]["{major}"]["zip"] -> { resource, checksum_sha256 }
/// Full URL: https://corretto.aws + resource
pub struct CorrettoProvider;

/// URL for the master index JSON
const INDEX_URL: &str = "https://raw.githubusercontent.com/corretto/corretto-downloads/main/latest_links/indexmap_with_checksum.json";

impl JdkProvider for CorrettoProvider {
    fn list_versions(&self, major: Option<u32>) -> Result<Vec<RemoteJdk>, AppError> {
        let index = fetch_index()?;
        match major {
            Some(major) => extract_from_index(&index, major),
            None => extract_all_from_index(&index),
        }
    }

    fn resolve(&self, version: &str) -> Result<RemoteJdk, AppError> {
        let parts: Vec<&str> = version.split('.').collect();
        let major: u32 = parts
            .first()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::Provider(format!("invalid version: {version}")))?;

        let versions = self.list_versions(Some(major))?;

        // Exact match first
        if let Some(exact) = versions.iter().find(|v| v.version == version) {
            return Ok(exact.clone());
        }

        // Return latest for this major
        versions.into_iter().next().ok_or_else(|| {
            AppError::Provider(format!("no Corretto JDK found for version {version}"))
        })
    }
}

fn extract_all_from_index(index: &serde_json::Value) -> Result<Vec<RemoteJdk>, AppError> {
    let majors = index
        .get("windows")
        .and_then(|w| w.get("x64"))
        .and_then(|a| a.get("jdk"))
        .and_then(|j| j.as_object());

    let Some(majors) = majors else {
        return Ok(vec![]);
    };

    let mut results = Vec::new();
    for key in majors.keys() {
        if let Ok(major) = key.parse::<u32>() {
            results.extend(extract_from_index(index, major)?);
        }
    }

    results.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(results)
}

/// Fetch and parse the master index JSON
fn fetch_index() -> Result<serde_json::Value, AppError> {
    let resp = crate::provider::http_client()
        .get(INDEX_URL)
        .send()
        .map_err(|e| AppError::Network(e))?;

    if !resp.status().is_success() {
        return Err(AppError::Provider(format!(
            "corretto index fetch failed: HTTP {}",
            resp.status()
        )));
    }

    resp.json()
        .map_err(|e| AppError::Provider(format!("corretto index parse error: {e}")))
}

/// Extract Windows x64 JDK zip info from the index for a given major version
fn extract_from_index(index: &serde_json::Value, major: u32) -> Result<Vec<RemoteJdk>, AppError> {
    let zip_info = index
        .get("windows")
        .and_then(|w| w.get("x64"))
        .and_then(|a| a.get("jdk"))
        .and_then(|j| j.get(&major.to_string()))
        .and_then(|m| m.get("zip"));

    let zip_info = match zip_info {
        Some(info) => info,
        None => return Ok(vec![]),
    };

    // Extract version from resource path: "/downloads/resources/21.0.11.10.1/..."
    let resource = zip_info
        .get("resource")
        .and_then(|r| r.as_str())
        .unwrap_or("");

    let version = extract_version_from_resource(resource);

    let url = format!("https://corretto.aws{}", resource);

    let checksum = zip_info
        .get("checksum_sha256")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());

    if version.is_empty() || resource.is_empty() {
        return Ok(vec![]);
    }

    Ok(vec![RemoteJdk {
        version,
        url,
        checksum,
        size: None,
    }])
}

/// Extract the Corretto version string from a resource path.
/// e.g., "/downloads/resources/21.0.11.10.1/amazon-corretto-21.0.11.10.1-windows-x64-jdk.zip"
/// -> "21.0.11"
fn extract_version_from_resource(resource: &str) -> String {
    // Split path and take the version directory part
    let parts: Vec<&str> = resource.split('/').collect();
    // parts = ["", "downloads", "resources", "21.0.11.10.1", "amazon-corretto-..."]
    let version_part = parts.get(3).unwrap_or(&"");

    // Corretto uses extended version like "21.0.11.10.1"
    // Convert to standard semver by taking first 3 components
    let nums: Vec<&str> = version_part.split('.').take(3).collect();
    if nums.len() == 3 {
        nums.join(".")
    } else {
        version_part.to_string()
    }
}
