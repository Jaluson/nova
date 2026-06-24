mod config;
mod download;
mod error;
mod extract;
mod jdk;
mod maven;
mod provider;
mod setup;
mod symlink;
mod version;

use setup::{JavaHomeStatus, MavenHomeStatus, SetupConfig};

use provider::RemoteJdk;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// JDK version entry for display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JdkEntry {
    pub version: String,
    pub provider: String,
    pub is_current: bool,
    pub install_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultJvmPaths {
    pub versions_dir: String,
    pub symlink_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultMavenPaths {
    pub versions_dir: String,
    pub symlink_path: String,
    pub settings_path: String,
}

// ─── Setup commands ────────────────────────────────────────────

/// Check if first-time setup is needed
#[tauri::command]
fn is_setup_needed() -> Result<bool, String> {
    setup::is_setup_needed().map_err(|e| e.to_string())
}

/// Complete the first-time setup
#[tauri::command]
fn complete_setup(config: SetupConfig) -> Result<(), String> {
    setup::complete_setup(config).map_err(|e| e.to_string())
}

/// Check JAVA_HOME status
#[tauri::command]
fn check_java_home() -> Result<JavaHomeStatus, String> {
    setup::check_java_home().map_err(|e| e.to_string())
}

/// Check MAVEN_HOME status
#[tauri::command]
fn check_maven_home() -> Result<MavenHomeStatus, String> {
    setup::check_maven_home().map_err(|e| e.to_string())
}

/// Check whether the current process can configure system environment variables
#[tauri::command]
fn can_configure_system_env() -> bool {
    setup::can_configure_system_env()
}

/// Configure JAVA_HOME and PATH for the current user
#[tauri::command]
async fn configure_java_home() -> Result<JavaHomeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| setup::configure_java_home().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Configure JAVA_HOME and PATH for the system
#[tauri::command]
async fn configure_system_java_home() -> Result<JavaHomeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        setup::configure_system_java_home().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Configure MAVEN_HOME and PATH for the current user
#[tauri::command]
async fn configure_maven_home() -> Result<MavenHomeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        setup::configure_maven_home().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Configure MAVEN_HOME and PATH for the system
#[tauri::command]
async fn configure_system_maven_home() -> Result<MavenHomeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        setup::configure_system_maven_home().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── JDK management commands ───────────────────────────────────

/// List installed JDK versions
#[tauri::command]
async fn list_versions() -> Result<Vec<JdkEntry>, String> {
    tauri::async_runtime::spawn_blocking(list_versions_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn list_versions_sync() -> Result<Vec<JdkEntry>, String> {
    let config = config::Config::load().map_err(|e| e.to_string())?;
    let versions_dir = config.versions_dir();

    if !versions_dir.exists() {
        return Ok(vec![]);
    }

    let symlink_path = config.symlink_path();
    let current_target = symlink::read_link(&symlink_path)
        .map_err(|e| e.to_string())?
        .map(|p| canonical_path(&p))
        .unwrap_or_default();

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&versions_dir).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let provider = detect_provider(&path);
        let is_current = canonical_path(&path) == current_target;

        entries.push(JdkEntry {
            version: name,
            provider,
            is_current,
            install_path: path.to_string_lossy().to_string(),
        });
    }

    // Sort by version (newest first)
    entries.sort_by(|a, b| {
        let va = version::JdkVersion::parse(&a.version).unwrap_or(version::JdkVersion {
            major: 0,
            minor: 0,
            patch: 0,
        });
        let vb = version::JdkVersion::parse(&b.version).unwrap_or(version::JdkVersion {
            major: 0,
            minor: 0,
            patch: 0,
        });
        vb.cmp(&va)
    });

    Ok(entries)
}

/// Get the currently active JDK version
#[tauri::command]
fn current_version() -> Result<Option<String>, String> {
    let config = config::Config::load().map_err(|e| e.to_string())?;
    let symlink_path = config.symlink_path();

    let Some(target) = symlink::read_link(&symlink_path).map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    let current_target = canonical_path(&target);
    let versions_dir = config.versions_dir();
    if versions_dir.exists() {
        let read_dir = std::fs::read_dir(&versions_dir).map_err(|e| e.to_string())?;
        for entry in read_dir {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() && canonical_path(&path) == current_target {
                return Ok(path.file_name().map(|n| n.to_string_lossy().to_string()));
            }
        }
    }

    Ok(target.file_name().map(|n| n.to_string_lossy().to_string()))
}

/// Install a JDK version from remote source
#[tauri::command]
async fn install_version(
    version: String,
    source: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let installed_version = tauri::async_runtime::spawn_blocking(move || {
        jdk::install_version(&version, &source, &app_handle).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(installed_version)
}

/// Import a JDK from local path
#[tauri::command]
fn import_jdk(path: String) -> Result<String, String> {
    jdk::import_jdk(&path).map_err(|e| e.to_string())
}

/// Switch to a specific JDK version
#[tauri::command]
async fn use_version(version: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        jdk::use_version(&version).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

/// Uninstall a JDK version
#[tauri::command]
fn uninstall_version(version: String) -> Result<(), String> {
    jdk::uninstall_version(&version).map_err(|e| e.to_string())
}

// ─── Maven management commands ─────────────────────────────────────────────

/// List installed Maven versions
#[tauri::command]
async fn list_maven_versions() -> Result<Vec<maven::MavenEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| maven::list_versions().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Get the currently active Maven version
#[tauri::command]
fn current_maven_version() -> Result<Option<String>, String> {
    maven::current_version().map_err(|e| e.to_string())
}

/// List remote Maven versions available for download
#[tauri::command]
async fn list_remote_maven_versions() -> Result<Vec<maven::RemoteMaven>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        maven::list_remote_versions().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Install a Maven version from Apache archives
#[tauri::command]
async fn install_maven_version(
    version: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        maven::install_version(&version, &app_handle).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import Maven from local path
#[tauri::command]
fn import_maven(path: String) -> Result<String, String> {
    maven::import_maven(&path).map_err(|e| e.to_string())
}

/// Switch to a specific Maven version
#[tauri::command]
async fn use_maven_version(version: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        maven::use_version(&version).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

/// Uninstall a Maven version
#[tauri::command]
fn uninstall_maven_version(version: String) -> Result<(), String> {
    maven::uninstall_version(&version).map_err(|e| e.to_string())
}

/// Pause a running JDK archive download
#[tauri::command]
fn pause_download(task_id: String) {
    download::pause_download(&task_id);
}

/// Resume a paused JDK archive download
#[tauri::command]
fn resume_download(task_id: String) {
    download::resume_download(&task_id);
}

/// Cancel a running or paused JDK archive download
#[tauri::command]
fn cancel_download(task_id: String) {
    download::cancel_download(&task_id);
}

/// List remote versions available for download
#[tauri::command]
async fn list_remote_versions(
    source: String,
    major: Option<u32>,
) -> Result<Vec<RemoteJdk>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        jdk::list_remote_versions(&source, major).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Config commands ───────────────────────────────────────────

/// Get current config
#[tauri::command]
fn get_config() -> Result<config::Config, String> {
    config::Config::load().map_err(|e| e.to_string())
}

/// Get the user's home directory path
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "cannot determine home directory".to_string())
}

/// Get default portable JVM paths used when config fields are empty.
#[tauri::command]
fn get_default_jvm_paths() -> DefaultJvmPaths {
    let config = config::Config::default();
    DefaultJvmPaths {
        versions_dir: config.versions_dir().to_string_lossy().to_string(),
        symlink_path: config.symlink_path().to_string_lossy().to_string(),
    }
}

/// Get default portable Maven paths used when config fields are empty.
#[tauri::command]
fn get_default_maven_paths() -> DefaultMavenPaths {
    let config = config::Config::default();
    DefaultMavenPaths {
        versions_dir: config.maven_versions_dir().to_string_lossy().to_string(),
        symlink_path: config.maven_symlink_path().to_string_lossy().to_string(),
        settings_path: config.maven_settings_path().to_string_lossy().to_string(),
    }
}

/// Update config
#[tauri::command]
fn update_config(new_config: config::Config) -> Result<(), String> {
    new_config.save().map_err(|e| e.to_string())
}

/// Update JVM paths, optionally migrating installed JDK files and rebuilding the symlink.
#[tauri::command]
fn update_jvm_config(new_config: config::Config, migrate_versions: bool) -> Result<(), String> {
    let old_config = config::Config::load().map_err(|e| e.to_string())?;
    let old_versions_dir = old_config.versions_dir();
    let new_versions_dir = new_config.versions_dir();
    let old_symlink_path = old_config.symlink_path();
    let new_symlink_path = new_config.symlink_path();
    let versions_changed = !same_path_text(&old_versions_dir, &new_versions_dir);
    let symlink_changed = !same_path_text(&old_symlink_path, &new_symlink_path);

    let mut current_target = symlink::read_link(&old_symlink_path).map_err(|e| e.to_string())?;

    if versions_changed && migrate_versions && old_versions_dir.exists() {
        migrate_dir_contents(&old_versions_dir, &new_versions_dir)?;
        if let Some(target) = current_target.as_ref() {
            current_target = map_migrated_target(target, &old_versions_dir, &new_versions_dir);
        }
    }

    if symlink_changed && symlink::is_link(&old_symlink_path) {
        symlink::remove(&old_symlink_path).map_err(|e| e.to_string())?;
    }

    new_config.save().map_err(|e| e.to_string())?;

    if symlink_changed {
        if let Some(target) = current_target {
            if target.exists() {
                symlink::create(&target, &new_symlink_path).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

/// Update Maven paths, optionally migrating installed Maven files and rebuilding the symlink.
#[tauri::command]
fn update_maven_config(new_config: config::Config, migrate_versions: bool) -> Result<(), String> {
    let old_config = config::Config::load().map_err(|e| e.to_string())?;
    let old_versions_dir = old_config.maven_versions_dir();
    let new_versions_dir = new_config.maven_versions_dir();
    let old_symlink_path = old_config.maven_symlink_path();
    let new_symlink_path = new_config.maven_symlink_path();
    let versions_changed = !same_path_text(&old_versions_dir, &new_versions_dir);
    let symlink_changed = !same_path_text(&old_symlink_path, &new_symlink_path);

    let mut current_target = symlink::read_link(&old_symlink_path).map_err(|e| e.to_string())?;

    if versions_changed && migrate_versions && old_versions_dir.exists() {
        migrate_dir_contents(&old_versions_dir, &new_versions_dir)?;
        if let Some(target) = current_target.as_ref() {
            current_target = map_migrated_target(target, &old_versions_dir, &new_versions_dir);
        }
    }

    if symlink_changed && symlink::is_link(&old_symlink_path) {
        symlink::remove(&old_symlink_path).map_err(|e| e.to_string())?;
    }

    new_config.save().map_err(|e| e.to_string())?;

    if symlink_changed {
        if let Some(target) = current_target {
            if target.exists() {
                symlink::create(&target, &new_symlink_path).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

/// Update JDK and Maven path config together so both migrations see the previous config.
#[tauri::command]
fn update_tool_config(
    new_config: config::Config,
    migrate_jvm_versions: bool,
    migrate_maven_versions: bool,
) -> Result<(), String> {
    let old_config = config::Config::load().map_err(|e| e.to_string())?;

    let old_jvm_versions_dir = old_config.versions_dir();
    let new_jvm_versions_dir = new_config.versions_dir();
    let old_jvm_symlink_path = old_config.symlink_path();
    let new_jvm_symlink_path = new_config.symlink_path();
    let jvm_versions_changed = !same_path_text(&old_jvm_versions_dir, &new_jvm_versions_dir);
    let jvm_symlink_changed = !same_path_text(&old_jvm_symlink_path, &new_jvm_symlink_path);
    let mut jvm_current_target =
        symlink::read_link(&old_jvm_symlink_path).map_err(|e| e.to_string())?;

    let old_maven_versions_dir = old_config.maven_versions_dir();
    let new_maven_versions_dir = new_config.maven_versions_dir();
    let old_maven_symlink_path = old_config.maven_symlink_path();
    let new_maven_symlink_path = new_config.maven_symlink_path();
    let maven_versions_changed = !same_path_text(&old_maven_versions_dir, &new_maven_versions_dir);
    let maven_symlink_changed = !same_path_text(&old_maven_symlink_path, &new_maven_symlink_path);
    let mut maven_current_target =
        symlink::read_link(&old_maven_symlink_path).map_err(|e| e.to_string())?;

    if jvm_versions_changed && migrate_jvm_versions && old_jvm_versions_dir.exists() {
        migrate_dir_contents(&old_jvm_versions_dir, &new_jvm_versions_dir)?;
        if let Some(target) = jvm_current_target.as_ref() {
            jvm_current_target =
                map_migrated_target(target, &old_jvm_versions_dir, &new_jvm_versions_dir);
        }
    }

    if maven_versions_changed && migrate_maven_versions && old_maven_versions_dir.exists() {
        migrate_dir_contents(&old_maven_versions_dir, &new_maven_versions_dir)?;
        if let Some(target) = maven_current_target.as_ref() {
            maven_current_target =
                map_migrated_target(target, &old_maven_versions_dir, &new_maven_versions_dir);
        }
    }

    if jvm_symlink_changed && symlink::is_link(&old_jvm_symlink_path) {
        symlink::remove(&old_jvm_symlink_path).map_err(|e| e.to_string())?;
    }
    if maven_symlink_changed && symlink::is_link(&old_maven_symlink_path) {
        symlink::remove(&old_maven_symlink_path).map_err(|e| e.to_string())?;
    }

    new_config.save().map_err(|e| e.to_string())?;

    if jvm_symlink_changed {
        if let Some(target) = jvm_current_target {
            if target.exists() {
                symlink::create(&target, &new_jvm_symlink_path).map_err(|e| e.to_string())?;
            }
        }
    }
    if maven_symlink_changed {
        if let Some(target) = maven_current_target {
            if target.exists() {
                symlink::create(&target, &new_maven_symlink_path).map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

/// Load Maven settings.xml management values.
#[tauri::command]
fn load_maven_settings() -> Result<maven::MavenSettings, String> {
    maven::load_settings().map_err(|e| e.to_string())
}

/// Save Maven settings.xml management values.
#[tauri::command]
fn save_maven_settings(settings: maven::MavenSettings) -> Result<(), String> {
    maven::save_settings(settings).map_err(|e| e.to_string())
}

// ─── Helpers ───────────────────────────────────────────────────

/// Detect the provider of an installed JDK by checking release file
fn detect_provider(path: &std::path::Path) -> String {
    let release_file = path.join("release");
    if let Ok(content) = std::fs::read_to_string(&release_file) {
        if content.contains("Corretto") || content.contains("Amazon") {
            return "Corretto".to_string();
        }
        if content.contains("Temurin")
            || content.contains("Adoptium")
            || content.contains("Eclipse")
        {
            return "Adoptium".to_string();
        }
        if content.contains("Zulu") || content.contains("Azul") {
            return "Zulu".to_string();
        }
    }

    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if name.contains("corretto") || name.contains("amazon") {
        return "Corretto".to_string();
    }
    if name.contains("adoptium") || name.contains("temurin") || name.contains("adopt") {
        return "Adoptium".to_string();
    }
    if name.contains("zulu") || name.contains("azul") {
        return "Zulu".to_string();
    }
    if name.contains("tsinghua") || name.contains("tuna") {
        return "Tsinghua".to_string();
    }

    "Unknown".to_string()
}

fn canonical_path(path: &std::path::Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

// ─── App entry point ───────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            is_setup_needed,
            complete_setup,
            check_java_home,
            check_maven_home,
            can_configure_system_env,
            configure_java_home,
            configure_system_java_home,
            configure_maven_home,
            configure_system_maven_home,
            list_versions,
            current_version,
            install_version,
            import_jdk,
            use_version,
            uninstall_version,
            list_maven_versions,
            current_maven_version,
            list_remote_maven_versions,
            install_maven_version,
            import_maven,
            use_maven_version,
            uninstall_maven_version,
            pause_download,
            resume_download,
            cancel_download,
            list_remote_versions,
            get_config,
            get_home_dir,
            get_default_jvm_paths,
            get_default_maven_paths,
            update_config,
            update_jvm_config,
            update_maven_config,
            update_tool_config,
            load_maven_settings,
            save_maven_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn same_path_text(left: &Path, right: &Path) -> bool {
    normalize_path_text(left) == normalize_path_text(right)
}

fn normalize_path_text(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn migrate_dir_contents(old_dir: &Path, new_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(new_dir)
        .map_err(|e| format!("failed to create {}: {e}", new_dir.display()))?;

    for entry in std::fs::read_dir(old_dir)
        .map_err(|e| format!("failed to read {}: {e}", old_dir.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let target = new_dir.join(entry.file_name());
        if target.exists() || std::fs::symlink_metadata(&target).is_ok() {
            return Err(format!("target already exists: {}", target.display()));
        }
        move_path(&source, &target)?;
    }

    Ok(())
}

fn move_path(source: &Path, target: &Path) -> Result<(), String> {
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_path(source, target)?;
            remove_path(source).map_err(|remove_error| {
                format!(
                    "copied {} to {}, but failed to remove original after rename failed ({rename_error}): {remove_error}",
                    source.display(),
                    target.display()
                )
            })
        }
    }
}

fn copy_path(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        copy_dir_recursive(source, target)
    } else {
        std::fs::copy(source, target).map(|_| ()).map_err(|e| {
            format!(
                "failed to copy {} to {}: {e}",
                source.display(),
                target.display()
            )
        })
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|e| format!("failed to create {}: {e}", target.display()))?;
    for entry in std::fs::read_dir(source)
        .map_err(|e| format!("failed to read {}: {e}", source.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        copy_path(&entry.path(), &target.join(entry.file_name()))?;
    }
    Ok(())
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

fn map_migrated_target(target: &Path, old_dir: &Path, new_dir: &Path) -> Option<PathBuf> {
    target
        .strip_prefix(old_dir)
        .ok()
        .map(|relative| new_dir.join(relative))
        .or_else(|| Some(target.to_path_buf()))
}
