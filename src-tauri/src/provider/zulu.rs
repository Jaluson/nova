use crate::error::AppError;
use crate::provider::{JdkProvider, RemoteJdk};

/// Azul Zulu JDK provider
///
/// Uses the Azul metadata API: https://api.azul.com/metadata/v1/zulu/packages
pub struct ZuluProvider;

/// Internal representation of a Zulu package with extra metadata
struct ZuluPackage {
    version: String,
    url: String,
    package_uuid: Option<String>,
}

/// Fetch Zulu packages from the API, filtered to plain JDK only (no JRE, no JavaFX bundles)
fn fetch_zulu_packages(major: Option<u32>) -> Result<Vec<ZuluPackage>, AppError> {
    let client = crate::provider::http_client();
    let mut url =
        "https://api.azul.com/metadata/v1/zulu/packages?os=windows&arch=x64&archive_type=zip&latest=true&bundle_type=jdk&crac_supported=false"
            .to_string();
    if let Some(major) = major {
        url.push_str(&format!("&java_version={major}"));
    }

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| AppError::Network(e))?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    let json: Vec<serde_json::Value> = resp
        .json()
        .map_err(|e| AppError::Provider(format!("zulu parse error: {e}")))?;

    let mut results = Vec::new();

    for item in &json {
        // Only include plain JDK packages (exclude JRE and JavaFX bundles)
        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !name.contains("-ca-jdk") {
            continue;
        }

        let version = item
            .get("java_version")
            .and_then(|v| v.as_array())
            .and_then(|parts| {
                let nums: Vec<String> = parts
                    .iter()
                    .filter_map(|p| p.as_u64().map(|n| n.to_string()))
                    .collect();
                if nums.len() >= 3 {
                    Some(nums[..3].join("."))
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let download_url = item
            .get("download_url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string();

        let package_uuid = item
            .get("package_uuid")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string());

        if !version.is_empty() && !download_url.is_empty() {
            results.push(ZuluPackage {
                version,
                url: download_url,
                package_uuid,
            });
        }
    }

    Ok(results)
}

impl JdkProvider for ZuluProvider {
    fn list_versions(&self, major: Option<u32>) -> Result<Vec<RemoteJdk>, AppError> {
        let packages = fetch_zulu_packages(major)?;
        Ok(packages
            .into_iter()
            .map(|p| RemoteJdk {
                version: p.version,
                url: p.url,
                checksum: None,
                size: None,
            })
            .collect())
    }

    fn resolve(&self, version: &str) -> Result<RemoteJdk, AppError> {
        let parts: Vec<&str> = version.split('.').collect();
        let major: u32 = parts
            .first()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::Provider(format!("invalid version: {version}")))?;

        let packages = fetch_zulu_packages(Some(major))?;

        // Exact match first
        let pkg = packages
            .iter()
            .find(|p| p.version == version)
            .or_else(|| packages.first())
            .ok_or_else(|| {
                AppError::Provider(format!("no Zulu JDK found for version {version}"))
            })?;

        // Fetch checksum only when resolving for download
        let checksum = pkg
            .package_uuid
            .as_deref()
            .and_then(fetch_zulu_checksum_by_uuid);

        Ok(RemoteJdk {
            version: pkg.version.clone(),
            url: pkg.url.clone(),
            checksum,
            size: None,
        })
    }
}

/// Validate UUID format (alphanumeric and hyphens only)
fn is_valid_uuid(uuid: &str) -> bool {
    uuid.chars().all(|c| c.is_alphanumeric() || c == '-')
}

/// Fetch SHA256 checksum from the package detail endpoint
fn fetch_zulu_checksum_by_uuid(package_uuid: &str) -> Option<String> {
    // Validate UUID format before using in URL
    if !is_valid_uuid(package_uuid) {
        eprintln!("Invalid package UUID format: {}", package_uuid);
        return None;
    }

    let client = crate::provider::http_client();
    let url = format!(
        "https://api.azul.com/metadata/v1/zulu/packages/{}",
        package_uuid
    );

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let detail: serde_json::Value = resp.json().ok()?;
    detail
        .get("sha256_hash")
        .and_then(|h| h.as_str())
        .map(|s| s.to_string())
}
