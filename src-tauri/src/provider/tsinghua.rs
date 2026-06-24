use crate::error::AppError;
use crate::provider::{JdkProvider, RemoteJdk};

/// Tsinghua University mirror JDK provider
///
/// Uses Tsinghua University's mirror for Adoptium JDK distributions:
/// https://mirrors.tuna.tsinghua.edu.cn/Adoptium/
///
/// This provider scrapes the mirror directory directly to ensure
/// only files that actually exist on the mirror are offered.
pub struct TsinghuaProvider;

const MIRROR_BASE: &str = "https://mirrors.tuna.tsinghua.edu.cn/Adoptium";

impl JdkProvider for TsinghuaProvider {
    fn list_versions(&self, major: Option<u32>) -> Result<Vec<RemoteJdk>, AppError> {
        let Some(major) = major else {
            let mut results = Vec::new();
            for major in scrape_available_majors()? {
                results.extend(self.list_versions(Some(major))?);
            }
            return Ok(results);
        };

        let dir_url = format!("{}/{}/jdk/x64/windows/", MIRROR_BASE, major);
        let html = http_get_text(&dir_url)?;
        let filenames = parse_directory_links(&html);

        let mut results = Vec::new();
        for filename in filenames {
            // Only consider .zip files
            if !filename.ends_with(".zip") {
                continue;
            }

            let version = parse_version_from_filename(&filename);
            // Skip if version parsing failed
            if version.is_empty() {
                continue;
            }
            let url = format!("{}/{}/jdk/x64/windows/{}", MIRROR_BASE, major, filename);

            results.push(RemoteJdk {
                version,
                url,
                checksum: None,
                size: None,
            });
        }

        Ok(results)
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
            AppError::Provider(format!("no Tsinghua JDK found for version {version}"))
        })
    }
}

/// Scrape the mirror root to find available major version directories
fn scrape_available_majors() -> Result<Vec<u32>, AppError> {
    let html = http_get_text(&format!("{}/", MIRROR_BASE))?;
    let links = parse_directory_links(&html);

    let mut majors: Vec<u32> = links
        .iter()
        .filter_map(|link| {
            // Directory links end with '/', e.g. "17/"
            let trimmed = link.trim_end_matches('/');
            trimmed.parse().ok()
        })
        .filter(|&m| m > 0)
        .collect();

    // Sort newest first
    majors.sort_by(|a, b| b.cmp(a));
    Ok(majors)
}

/// Extract file/directory links from the mirror's HTML directory listing
fn parse_directory_links(html: &str) -> Vec<String> {
    let mut links = Vec::new();

    for line in html.lines() {
        // Look for <a href="filename"> patterns
        if let Some(href) = extract_href(line) {
            // Skip parent directory link
            if href == "../" || href == "/" {
                continue;
            }
            links.push(href);
        }
    }

    links
}

/// Extract href value from an <a> tag line
fn extract_href(line: &str) -> Option<String> {
    let line = line.trim();

    // Find href="..."
    let start = line.find("href=\"")?;
    let rest = &line[start + 6..];
    let end = rest.find('"')?;
    let href = &rest[..end];

    // Only return meaningful filenames (not parent dir or empty)
    if href.is_empty() || href == "#" {
        return None;
    }

    Some(href.to_string())
}

/// Parse version string from Adoptium-style filename
///
/// Example: `OpenJDK17U-jdk_x64_windows_hotspot_17.0.19_10.zip`
/// → `17.0.19+10`
///
/// Returns empty string if format doesn't match expected pattern
fn parse_version_from_filename(filename: &str) -> String {
    // Remove extension
    let name = filename.strip_suffix(".zip").unwrap_or(filename);

    // Split by underscore: OpenJDK17U-jdk, x64, windows, hotspot, 17.0.19, 10
    let parts: Vec<&str> = name.split('_').collect();

    // The version is the second-to-last part (e.g., "17.0.19")
    // and the build number is the last part (e.g., "10")
    if parts.len() >= 2 {
        let version_part = parts[parts.len() - 2];
        let build_part = parts[parts.len() - 1];

        // Validate that version part contains numbers and dots only
        if version_part.chars().all(|c| c.is_numeric() || c == '.')
            && build_part.chars().all(|c| c.is_numeric())
        {
            return format!("{}+{}", version_part, build_part);
        }
    }

    // Fallback: return empty string if format doesn't match
    String::new()
}

/// HTTP GET returning text body
fn http_get_text(url: &str) -> Result<String, AppError> {
    let resp = crate::provider::http_client()
        .get(url)
        .header("User-Agent", "nova-jdk-manager/1.0")
        .send()
        .map_err(AppError::Network)?;

    if !resp.status().is_success() {
        return Err(AppError::Provider(format!(
            "tsinghua mirror request failed: HTTP {}",
            resp.status()
        )));
    }

    resp.text()
        .map_err(|e| AppError::Provider(format!("tsinghua mirror read error: {e}")))
}
