use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{Config, MavenMirrorConfig};
use crate::error::AppError;
use crate::extract::extract_zip;
use crate::symlink;

const MAVEN_METADATA_URL: &str =
    "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml";
const MAVEN_ARCHIVE_BASE: &str = "https://archive.apache.org/dist/maven";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MavenEntry {
    pub version: String,
    pub provider: String,
    pub is_current: bool,
    pub install_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteMaven {
    pub version: String,
    pub source: String,
    pub url: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MavenSettings {
    pub settings_path: String,
    pub local_repository: Option<String>,
    pub mirrors: Vec<MavenMirrorConfig>,
    pub raw_content: String,
}

pub fn list_versions() -> Result<Vec<MavenEntry>, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.maven_versions_dir();

    if !versions_dir.exists() {
        return Ok(vec![]);
    }

    let current_target = symlink::read_link(&config.maven_symlink_path())?
        .map(|p| canonical_path(&p))
        .unwrap_or_default();

    let mut entries = Vec::new();
    for entry in fs::read_dir(&versions_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let version = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        entries.push(MavenEntry {
            version,
            provider: "Apache Maven".to_string(),
            is_current: canonical_path(&path) == current_target,
            install_path: path.to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| compare_versions(&b.version, &a.version));
    Ok(entries)
}

pub fn current_version() -> Result<Option<String>, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let Some(target) = symlink::read_link(&config.maven_symlink_path())? else {
        return Ok(None);
    };

    let current_target = canonical_path(&target);
    let versions_dir = config.maven_versions_dir();
    if versions_dir.exists() {
        for entry in fs::read_dir(&versions_dir)? {
            let path = entry?.path();
            if path.is_dir() && canonical_path(&path) == current_target {
                return Ok(path.file_name().map(|n| n.to_string_lossy().to_string()));
            }
        }
    }

    Ok(target.file_name().map(|n| n.to_string_lossy().to_string()))
}

pub fn list_remote_versions() -> Result<Vec<RemoteMaven>, AppError> {
    let content = reqwest::blocking::Client::new()
        .get(MAVEN_METADATA_URL)
        .header("User-Agent", "nova/1.0")
        .send()?
        .error_for_status()?
        .text()?;

    let mut versions = extract_tag_values(&content, "version")
        .into_iter()
        .filter(|version| !version.trim().is_empty())
        .map(|version| {
            let url = archive_url(&version);
            RemoteMaven {
                version,
                source: "apache".to_string(),
                url,
                size: None,
            }
        })
        .collect::<Vec<_>>();
    versions.sort_by(|a, b| compare_versions(&b.version, &a.version));
    Ok(versions)
}

pub fn install_version(version: &str, app_handle: &tauri::AppHandle) -> Result<String, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.maven_versions_dir();
    fs::create_dir_all(&versions_dir)?;

    let install_dir = versions_dir.join(version);
    if install_dir.exists() {
        return Err(AppError::MavenAlreadyInstalled(version.to_string()));
    }

    let task_id = format!("maven:{version}");
    crate::download::prepare_download(&task_id);
    let file_name = format!("apache-maven-{version}-bin.zip");
    let archive_path =
        crate::download::download_file(&archive_url(version), &file_name, &task_id, app_handle)?;
    let extracted = match extract_zip(&archive_path, &versions_dir) {
        Ok(path) => path,
        Err(e) => {
            let _ = fs::remove_file(&archive_path);
            return Err(e);
        }
    };

    if extracted != install_dir {
        fs::rename(&extracted, &install_dir).map_err(|e| {
            AppError::Extraction(format!(
                "rename {} -> {}: {e}",
                extracted.display(),
                install_dir.display()
            ))
        })?;
    }

    Ok(version.to_string())
}

pub fn import_maven(path: &str) -> Result<String, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.maven_versions_dir();
    let source = Path::new(path);

    let (version, maven_dir) = if source.is_dir() {
        let version = detect_maven_version(source);
        let link_path = versions_dir.join(&version);
        if link_path.exists() || symlink::read_link(&link_path)?.is_some() {
            return Err(AppError::MavenAlreadyInstalled(version));
        }
        fs::create_dir_all(&versions_dir)?;
        symlink::create(source, &link_path)?;
        (version, link_path)
    } else if source.extension().map(|e| e == "zip").unwrap_or(false) {
        let temp_dir =
            std::env::temp_dir().join(format!("nova-maven-extract-{}", std::process::id()));
        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }

        let extracted = extract_zip(source, &temp_dir)?;
        let version = detect_maven_version(&extracted);
        let install_dir = versions_dir.join(&version);
        if install_dir.exists() || symlink::read_link(&install_dir)?.is_some() {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(AppError::MavenAlreadyInstalled(version));
        }

        fs::create_dir_all(&versions_dir)?;
        fs::rename(&extracted, &install_dir).map_err(|e| {
            AppError::Extraction(format!(
                "rename {} -> {}: {e}",
                extracted.display(),
                install_dir.display()
            ))
        })?;
        let _ = fs::remove_dir_all(&temp_dir);
        (version, install_dir)
    } else {
        return Err(AppError::Extraction(
            "unsupported file format, expected directory or .zip".to_string(),
        ));
    };

    let current_symlink = config.maven_symlink_path();
    if !current_symlink.exists() {
        symlink::create(&link_target_path(&maven_dir), &current_symlink)?;
    }

    Ok(version)
}

pub fn use_version(version: &str) -> Result<(), AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let target = config.maven_versions_dir().join(version);
    if !target.exists() {
        return Err(AppError::MavenNotFound(version.to_string()));
    }

    let active_target = link_target_path(&target);
    let symlink_path = config.maven_symlink_path();
    if symlink::read_link(&symlink_path)?.is_some() {
        symlink::update(&active_target, &symlink_path)
    } else {
        symlink::create(&active_target, &symlink_path)
    }
}

pub fn uninstall_version(version: &str) -> Result<(), AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let target = config.maven_versions_dir().join(version);
    if !target.exists() {
        return Err(AppError::MavenNotFound(version.to_string()));
    }

    let symlink_path = config.maven_symlink_path();
    if let Some(current) = symlink::read_link(&symlink_path)? {
        if canonical_path(&current) == canonical_path(&target) {
            symlink::remove(&symlink_path)?;
        }
    }

    fs::remove_dir_all(&target).map_err(AppError::Io)
}

pub fn load_settings() -> Result<MavenSettings, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let settings_path = config.maven_settings_path();
    let raw_content = fs::read_to_string(&settings_path).unwrap_or_default();
    let local_repository = config
        .maven
        .local_repository
        .clone()
        .or_else(|| extract_tag_value(&raw_content, "localRepository"));
    let mirrors = if config.maven.mirrors.is_empty() {
        extract_mirrors(&raw_content)
    } else {
        config.maven.mirrors.clone()
    };

    Ok(MavenSettings {
        settings_path: settings_path.to_string_lossy().to_string(),
        local_repository,
        mirrors,
        raw_content,
    })
}

pub fn save_settings(settings: MavenSettings) -> Result<(), AppError> {
    let mut config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    config.maven.settings_path = Some(settings.settings_path.clone());
    config.maven.local_repository = settings.local_repository.clone();
    config.maven.mirrors = settings.mirrors.clone();

    let settings_path = PathBuf::from(&settings.settings_path);
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let existing = fs::read_to_string(&settings_path).unwrap_or_default();
    let content = merge_settings_xml(
        &existing,
        settings.local_repository.as_deref(),
        &settings.mirrors,
    );
    fs::write(&settings_path, content)?;
    config.save().map_err(|e| AppError::Config(e.to_string()))
}

fn archive_url(version: &str) -> String {
    let major = version.split('.').next().unwrap_or("3");
    format!("{MAVEN_ARCHIVE_BASE}/maven-{major}/{version}/binaries/apache-maven-{version}-bin.zip")
}

fn detect_maven_version(dir: &Path) -> String {
    if let Some(name) = dir.file_name().map(|n| n.to_string_lossy().to_string()) {
        if let Some(version) = name.strip_prefix("apache-maven-") {
            return version.to_string();
        }
        return name;
    }
    "unknown".to_string()
}

#[cfg(windows)]
fn link_target_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

#[cfg(not(windows))]
fn link_target_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = version_parts(left);
    let right_parts = version_parts(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_part = left_parts.get(index).map(String::as_str).unwrap_or("0");
        let right_part = right_parts.get(index).map(String::as_str).unwrap_or("0");
        let ordering = match (left_part.parse::<u32>(), right_part.parse::<u32>()) {
            (Ok(left_num), Ok(right_num)) => left_num.cmp(&right_num),
            _ => left_part.cmp(right_part),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

fn version_parts(version: &str) -> Vec<String> {
    version
        .split(['.', '-', '_'])
        .map(|part| part.to_string())
        .collect()
}

fn extract_tag_values(content: &str, tag: &str) -> Vec<String> {
    let mut values = Vec::new();
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let mut rest = content;
    while let Some(start) = rest.find(&start_tag) {
        let after_start = &rest[start + start_tag.len()..];
        let Some(end) = after_start.find(&end_tag) else {
            break;
        };
        values.push(after_start[..end].trim().to_string());
        rest = &after_start[end + end_tag.len()..];
    }
    values
}

fn extract_tag_value(content: &str, tag: &str) -> Option<String> {
    extract_tag_values(content, tag).into_iter().next()
}

fn extract_mirrors(content: &str) -> Vec<MavenMirrorConfig> {
    extract_tag_values(content, "mirror")
        .into_iter()
        .filter_map(|mirror| {
            let id = extract_tag_value(&mirror, "id")?;
            let url = extract_tag_value(&mirror, "url")?;
            Some(MavenMirrorConfig {
                id,
                name: extract_tag_value(&mirror, "name").unwrap_or_default(),
                url,
                mirror_of: extract_tag_value(&mirror, "mirrorOf")
                    .unwrap_or_else(|| "*".to_string()),
            })
        })
        .collect()
}

fn merge_settings_xml(
    existing: &str,
    local_repository: Option<&str>,
    mirrors: &[MavenMirrorConfig],
) -> String {
    let mut content = if existing.trim().is_empty() {
        default_settings_xml()
    } else {
        existing.to_string()
    };

    content = remove_tag_block(&content, "localRepository");
    content = remove_tag_block(&content, "mirrors");

    let mut insert = String::new();
    if let Some(local_repository) = local_repository.filter(|value| !value.trim().is_empty()) {
        insert.push_str(&format!(
            "\n  <localRepository>{}</localRepository>",
            escape_xml(local_repository)
        ));
    }
    if !mirrors.is_empty() {
        insert.push_str("\n  <mirrors>");
        for mirror in mirrors {
            insert.push_str(&format!(
                "\n    <mirror>\n      <id>{}</id>\n      <name>{}</name>\n      <url>{}</url>\n      <mirrorOf>{}</mirrorOf>\n    </mirror>",
                escape_xml(&mirror.id),
                escape_xml(&mirror.name),
                escape_xml(&mirror.url),
                escape_xml(&mirror.mirror_of)
            ));
        }
        insert.push_str("\n  </mirrors>");
    }

    insert_after_settings_start(&content, &insert)
}

fn default_settings_xml() -> String {
    r#"<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
</settings>
"#
    .to_string()
}

fn remove_tag_block(content: &str, tag: &str) -> String {
    let start_tag = format!("<{tag}");
    let end_tag = format!("</{tag}>");
    let Some(start) = content.find(&start_tag) else {
        return content.to_string();
    };
    let Some(relative_end) = content[start..].find(&end_tag) else {
        return content.to_string();
    };
    let end = start + relative_end + end_tag.len();
    format!(
        "{}{}",
        content[..start].trim_end(),
        content[end..].trim_start()
    )
}

fn insert_after_settings_start(content: &str, insert: &str) -> String {
    if insert.is_empty() {
        return content.to_string();
    }

    let Some(settings_start) = content.find("<settings") else {
        return format!("{}{}", default_settings_xml(), insert);
    };
    let Some(relative_end) = content[settings_start..].find('>') else {
        return content.to_string();
    };
    let insert_at = settings_start + relative_end + 1;
    format!(
        "{}{}{}",
        &content[..insert_at],
        insert,
        &content[insert_at..]
    )
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
