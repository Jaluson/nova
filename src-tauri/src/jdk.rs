use std::fs;
use std::path::Path;

use crate::config::Config;
use crate::error::AppError;
use crate::extract::extract_zip;
use crate::provider::adoptium::AdoptiumProvider;
use crate::provider::corretto::CorrettoProvider;
use crate::provider::tsinghua::TsinghuaProvider;
use crate::provider::zulu::ZuluProvider;
use crate::provider::{JdkProvider, RemoteJdk};
use crate::symlink;

/// Install a JDK version from a remote provider
pub fn install_version(
    version: &str,
    source: &str,
    app_handle: &tauri::AppHandle,
) -> Result<String, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.versions_dir();
    fs::create_dir_all(&versions_dir).map_err(AppError::Io)?;

    let task_id = format!("{source}:{version}");
    crate::download::prepare_download(&task_id);

    // Step 1: Resolve download URL from provider
    let jdk = match resolve_provider(source).and_then(|provider| provider.resolve(version)) {
        Ok(jdk) => jdk,
        Err(e) => {
            crate::download::clear_download(&task_id);
            return Err(e);
        }
    };

    // Step 2: Check if already installed before downloading
    let install_name = format!("{}-{}", source, jdk.version);
    let install_dir = versions_dir.join(&install_name);
    if install_dir.exists() {
        crate::download::clear_download(&task_id);
        return Err(AppError::JdkAlreadyInstalled(install_name));
    }

    // Step 3: Download archive
    let file_name = format!("{}-{}.zip", source, jdk.version);
    let archive_path = crate::download::download_file(&jdk.url, &file_name, &task_id, app_handle)?;

    // Step 4: Verify checksum if available
    if let Some(checksum) = &jdk.checksum {
        let valid = crate::download::verify_checksum(&archive_path, checksum)?;
        if !valid {
            // Delete corrupted download
            let _ = fs::remove_file(&archive_path);
            return Err(AppError::ChecksumMismatch {
                expected: checksum.clone(),
                actual: "computed hash".to_string(),
            });
        }
    }

    // Step 5: Extract
    let extracted = match extract_zip(&archive_path, &versions_dir) {
        Ok(path) => path,
        Err(e) => {
            let _ = fs::remove_file(&archive_path);
            return Err(e);
        }
    };

    // Step 6: Rename extracted directory to version name if needed
    if extracted != install_dir {
        fs::rename(&extracted, &install_dir).map_err(|e| {
            AppError::Extraction(format!(
                "rename {} -> {}: {e}",
                extracted.display(),
                install_dir.display()
            ))
        })?;
    }

    Ok(install_name)
}

/// Import a JDK from a local directory or zip file.
/// Directories are linked in place; zip files are extracted into managed storage.
pub fn import_jdk(path: &str) -> Result<String, AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.versions_dir();
    let source = Path::new(path);

    let (import_name, jdk_dir) = if source.is_dir() {
        let provider = detect_provider_from_dir(source);
        let version = detect_version_from_dir(source)?;
        let import_name = format!("{}-{}", provider.to_lowercase().replace(' ', "-"), version);
        let link_path = versions_dir.join(&import_name);

        if link_path.exists() || symlink::read_link(&link_path)?.is_some() {
            return Err(AppError::JdkAlreadyInstalled(import_name));
        }

        symlink::create(source, &link_path).map_err(|e| {
            AppError::Symlink(format!(
                "failed to create symlink {} -> {}: {}",
                link_path.display(),
                source.display(),
                e
            ))
        })?;

        (import_name, link_path)
    } else if source.extension().map(|e| e == "zip").unwrap_or(false) {
        let temp_dir =
            std::env::temp_dir().join(format!("nova-jdk-extract-{}", std::process::id()));
        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }

        let extracted = extract_zip(source, &temp_dir)?;
        let provider = detect_provider_from_dir(&extracted);
        let version = detect_version_from_dir(&extracted)?;
        let import_name = format!("{}-{}", provider.to_lowercase().replace(' ', "-"), version);
        let install_dir = versions_dir.join(&import_name);

        if install_dir.exists() || symlink::read_link(&install_dir)?.is_some() {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(AppError::JdkAlreadyInstalled(import_name));
        }

        fs::create_dir_all(&versions_dir).map_err(AppError::Io)?;
        fs::rename(&extracted, &install_dir).map_err(|e| {
            AppError::Extraction(format!(
                "rename {} -> {}: {e}",
                extracted.display(),
                install_dir.display()
            ))
        })?;
        let _ = fs::remove_dir_all(&temp_dir);

        (import_name, install_dir)
    } else {
        return Err(AppError::Extraction(
            "unsupported file format, expected directory or .zip".to_string(),
        ));
    };

    let current_symlink = config.symlink_path();
    if !current_symlink.exists() {
        let active_target = link_target_path(&jdk_dir);
        symlink::create(&active_target, &current_symlink)?;
    }

    Ok(import_name)
}

/// Switch the active JDK version by updating the symlink
pub fn use_version(version: &str) -> Result<(), AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.versions_dir();
    let target = versions_dir.join(version);

    if !target.exists() {
        return Err(AppError::JdkNotFound(version.to_string()));
    }

    let active_target = link_target_path(&target);
    let symlink_path = config.symlink_path();
    if symlink::read_link(&symlink_path)?.is_some() {
        symlink::update(&active_target, &symlink_path)
    } else {
        symlink::create(&active_target, &symlink_path)
    }
}

/// Uninstall a JDK version
pub fn uninstall_version(version: &str) -> Result<(), AppError> {
    let config = Config::load().map_err(|e| AppError::Config(e.to_string()))?;
    let versions_dir = config.versions_dir();
    let target = versions_dir.join(version);

    if !target.exists() {
        return Err(AppError::JdkNotFound(version.to_string()));
    }

    // Check if it's the current version
    let symlink_path = config.symlink_path();
    if let Some(current) = symlink::read_link(&symlink_path)? {
        if current == target {
            symlink::remove(&symlink_path)?;
        }
    }

    fs::remove_dir_all(&target).map_err(|e| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("failed to remove {}: {e}", target.display()),
        ))
    })
}

/// List remote versions for a given source
pub fn list_remote_versions(source: &str, major: Option<u32>) -> Result<Vec<RemoteJdk>, AppError> {
    let provider = resolve_provider(source)?;
    provider.list_versions(major)
}

// ─── Helpers ───────────────────────────────────────────────────

fn resolve_provider(source: &str) -> Result<Box<dyn JdkProvider>, AppError> {
    match source {
        "corretto" => Ok(Box::new(CorrettoProvider)),
        "adoptium" => Ok(Box::new(AdoptiumProvider)),
        "zulu" => Ok(Box::new(ZuluProvider)),
        "tsinghua" => Ok(Box::new(TsinghuaProvider)),
        _ => Err(AppError::Provider(format!("unknown provider: {source}"))),
    }
}

#[cfg(windows)]
fn link_target_path(path: &Path) -> std::path::PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(path)
    }
}

#[cfg(not(windows))]
fn link_target_path(path: &Path) -> std::path::PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Detect JDK provider from directory, returning standardized prefix
/// Returns: "amazon-corretto", "adoptium", "zulu", or "unknown"
fn detect_provider_from_dir(dir: &Path) -> String {
    let release = dir.join("release");
    if let Ok(content) = fs::read_to_string(&release) {
        if content.contains("Corretto") || content.contains("Amazon") {
            return "amazon-corretto".to_string();
        }
        if content.contains("Temurin")
            || content.contains("Adoptium")
            || content.contains("Eclipse")
        {
            return "adoptium".to_string();
        }
        if content.contains("Zulu") || content.contains("Azul") {
            return "zulu".to_string();
        }
    }

    // Fallback: check directory name
    if let Some(name) = dir.file_name() {
        let name_str = name.to_string_lossy().to_lowercase();
        if name_str.contains("corretto") || name_str.contains("amazon") {
            return "amazon-corretto".to_string();
        }
        if name_str.contains("temurin")
            || name_str.contains("adoptium")
            || name_str.contains("adopt")
        {
            return "adoptium".to_string();
        }
        if name_str.contains("zulu") || name_str.contains("azul") {
            return "zulu".to_string();
        }
    }

    "unknown".to_string()
}

/// Detect JDK version from the release file in a JDK directory
fn detect_version_from_dir(dir: &Path) -> Result<String, AppError> {
    let release = dir.join("release");
    if let Ok(content) = fs::read_to_string(&release) {
        // Look for JAVA_VERSION="21.0.11"
        for line in content.lines() {
            if line.starts_with("JAVA_VERSION=") {
                let v = line
                    .trim_start_matches("JAVA_VERSION=")
                    .trim_matches('"')
                    .to_string();
                return Ok(v);
            }
        }
    }

    // Fallback: use directory name
    Ok(dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string())
}
