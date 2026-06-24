use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::config::Config;
use crate::error::AppError;

enum EnvScope {
    User,
    System,
}

/// Setup configuration from the first-run wizard
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupConfig {
    /// Custom JDK installation directory
    pub versions_dir: Option<String>,
    /// Custom symlink path
    pub symlink_path: Option<String>,
}

/// JAVA_HOME detection result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaHomeStatus {
    /// Current JAVA_HOME value (if set)
    pub java_home: Option<String>,
    /// Whether JAVA_HOME points to our symlink path
    pub points_to_symlink: bool,
    /// The expected symlink path
    pub symlink_path: String,
}

/// MAVEN_HOME detection result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MavenHomeStatus {
    /// Current MAVEN_HOME value (if set)
    pub maven_home: Option<String>,
    /// Whether MAVEN_HOME points to our Maven symlink path
    pub points_to_symlink: bool,
    /// The expected Maven symlink path
    pub symlink_path: String,
}

/// Check if the first-time setup is needed
pub fn is_setup_needed() -> Result<bool, AppError> {
    let config = Config::load().unwrap_or_default();
    Ok(!config.jvm.setup_done)
}

/// Complete the first-time setup
pub fn complete_setup(setup: SetupConfig) -> Result<(), AppError> {
    // Step 1: Build config from user choices
    let mut config = Config::default();
    config.jvm.versions_dir = setup.versions_dir;
    config.jvm.symlink_path = setup.symlink_path;
    config.jvm.setup_done = true;

    // Step 2: Create directory structure
    config
        .ensure_dirs()
        .map_err(|e| AppError::Config(format!("failed to create directories: {e}")))?;

    // Step 3: Save config
    config
        .save()
        .map_err(|e| AppError::Config(format!("failed to save config: {e}")))?;

    Ok(())
}

/// Check the current JAVA_HOME status against our symlink path
pub fn check_java_home() -> Result<JavaHomeStatus, AppError> {
    let config = Config::load().unwrap_or_default();
    let symlink_path = config.symlink_path();
    let symlink_str = symlink_path.to_string_lossy().to_string();

    let process_java_home = std::env::var("JAVA_HOME").ok();
    let user_java_home = get_user_env("JAVA_HOME");
    let system_java_home = get_system_env("JAVA_HOME");
    let java_home = user_java_home
        .clone()
        .or(process_java_home.clone())
        .or(system_java_home.clone());
    let points_to_symlink = home_points_to_symlink(
        user_java_home.as_deref(),
        process_java_home.as_deref(),
        system_java_home.as_deref(),
        &symlink_path,
        &symlink_str,
    );

    Ok(JavaHomeStatus {
        java_home,
        points_to_symlink,
        symlink_path: symlink_str,
    })
}

/// Validate that a path string contains only safe characters
fn is_safe_path_value(value: &str) -> bool {
    // Allow alphanumeric, common path separators, and special characters used in paths
    value.chars().all(|c| {
        c.is_alphanumeric()
            || c == '\\'
            || c == '/'
            || c == ':'
            || c == '.'
            || c == '_'
            || c == '-'
            || c == ' '
            || c == ';'
    })
}

/// Configure user-level JAVA_HOME and PATH for the Nova symlink path.
pub fn configure_java_home() -> Result<JavaHomeStatus, AppError> {
    let config = Config::load().unwrap_or_default();
    let symlink_path = config.symlink_path();
    configure_home_env("JAVA_HOME", &symlink_path, EnvScope::User)?;
    check_java_home()
}

/// Configure system-level JAVA_HOME and PATH for the Nova symlink path.
pub fn configure_system_java_home() -> Result<JavaHomeStatus, AppError> {
    let config = Config::load().unwrap_or_default();
    let symlink_path = config.symlink_path();
    configure_home_env("JAVA_HOME", &symlink_path, EnvScope::System)?;
    check_java_home()
}

/// Configure user-level MAVEN_HOME and PATH for the Nova Maven symlink path.
pub fn configure_maven_home() -> Result<MavenHomeStatus, AppError> {
    let config = Config::load().unwrap_or_default();
    let symlink_path = config.maven_symlink_path();
    configure_home_env("MAVEN_HOME", &symlink_path, EnvScope::User)?;
    check_maven_home()
}

/// Configure system-level MAVEN_HOME and PATH for the Nova Maven symlink path.
pub fn configure_system_maven_home() -> Result<MavenHomeStatus, AppError> {
    let config = Config::load().unwrap_or_default();
    let symlink_path = config.maven_symlink_path();
    configure_home_env("MAVEN_HOME", &symlink_path, EnvScope::System)?;
    check_maven_home()
}

/// Check whether Nova can write system environment variables.
pub fn can_configure_system_env() -> bool {
    can_write_system_env()
}

/// Check the current MAVEN_HOME status against our Maven symlink path.
pub fn check_maven_home() -> Result<MavenHomeStatus, AppError> {
    let config = Config::load().unwrap_or_default();
    let symlink_path = config.maven_symlink_path();
    let symlink_str = symlink_path.to_string_lossy().to_string();

    let process_maven_home = std::env::var("MAVEN_HOME").ok();
    let user_maven_home = get_user_env("MAVEN_HOME");
    let system_maven_home = get_system_env("MAVEN_HOME");
    let maven_home = user_maven_home
        .clone()
        .or(process_maven_home.clone())
        .or(system_maven_home.clone());
    let points_to_symlink = home_points_to_symlink(
        user_maven_home.as_deref(),
        process_maven_home.as_deref(),
        system_maven_home.as_deref(),
        &symlink_path,
        &symlink_str,
    );

    Ok(MavenHomeStatus {
        maven_home,
        points_to_symlink,
        symlink_path: symlink_str,
    })
}

fn configure_home_env(name: &str, symlink_path: &Path, scope: EnvScope) -> Result<(), AppError> {
    if let Some(parent) = symlink_path.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::Io)?;
    }

    let symlink_str = symlink_path.to_string_lossy().to_string();
    if !is_safe_path_value(&symlink_str) {
        return Err(AppError::Config(format!(
            "invalid characters in symlink path: {}",
            symlink_path.display()
        )));
    }

    set_scoped_env(&scope, name, &symlink_str)?;

    let bin_path = symlink_path.join("bin").to_string_lossy().to_string();
    let current_path = get_scoped_env(&scope, "Path").unwrap_or_default();
    if !path_contains(&current_path, &bin_path) {
        let updated_path = if current_path.trim().is_empty() {
            bin_path
        } else {
            format!("{};{}", current_path.trim_end_matches(';'), bin_path)
        };
        set_scoped_env(&scope, "Path", &updated_path)?;
    }

    std::env::set_var(name, &symlink_str);
    Ok(())
}

fn get_scoped_env(scope: &EnvScope, name: &str) -> Option<String> {
    match scope {
        EnvScope::User => get_user_env(name),
        EnvScope::System => get_system_env(name),
    }
}

fn set_scoped_env(scope: &EnvScope, name: &str, value: &str) -> Result<(), AppError> {
    match scope {
        EnvScope::User => set_user_env(name, value),
        EnvScope::System => set_system_env(name, value),
    }
}

fn home_points_to_symlink(
    user_home: Option<&str>,
    process_home: Option<&str>,
    system_home: Option<&str>,
    symlink_path: &Path,
    symlink_str: &str,
) -> bool {
    user_home
        .or(process_home)
        .or(system_home)
        .is_some_and(|home| path_matches_symlink(home, symlink_path, symlink_str))
}

fn path_matches_symlink(home: &str, symlink_path: &Path, symlink_str: &str) -> bool {
    let normalized_home = normalize_path(home);
    let normalized_symlink = normalize_path(symlink_str);
    if normalized_home == normalized_symlink {
        return true;
    }

    let home_canonical = Path::new(home).canonicalize().ok();
    let symlink_canonical = symlink_path.canonicalize().ok();
    match (home_canonical, symlink_canonical) {
        (Some(h), Some(s)) => {
            normalize_path(&h.to_string_lossy()) == normalize_path(&s.to_string_lossy())
        }
        _ => false,
    }
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn path_contains(path_value: &str, needle: &str) -> bool {
    let normalized_needle = normalize_path(needle);
    path_value
        .split(';')
        .any(|part| normalize_path(part.trim()) == normalized_needle)
}

#[cfg(windows)]
fn get_user_env(name: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    let subkey = wide_null("Environment");
    let value_name = wide_null(name);
    let mut byte_len = 0u32;

    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if status != ERROR_SUCCESS || byte_len == 0 {
        return None;
    }

    let mut buffer = vec![0u16; byte_len as usize / 2];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut byte_len,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    let len = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..len]).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(windows)]
fn get_system_env(name: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    let subkey = wide_null("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
    let value_name = wide_null(name);
    let mut byte_len = 0u32;

    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if status != ERROR_SUCCESS || byte_len == 0 {
        return None;
    }

    let mut buffer = vec![0u16; byte_len as usize / 2];
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut byte_len,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    let len = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..len]).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(not(windows))]
fn get_user_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(not(windows))]
fn get_system_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(windows)]
fn set_user_env(name: &str, value: &str) -> Result<(), AppError> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_EXPAND_SZ};

    let subkey = wide_null("Environment");
    let value_name = wide_null(name);
    let data = wide_null(value);
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            REG_EXPAND_SZ,
            data.as_ptr().cast(),
            (data.len() * std::mem::size_of::<u16>()) as u32,
        )
    };

    if status == ERROR_SUCCESS {
        notify_environment_changed();
        return Ok(());
    }

    Err(AppError::Config(format!(
        "failed to update user environment variable {name}: Windows error {status}"
    )))
}

#[cfg(windows)]
fn set_system_env(name: &str, value: &str) -> Result<(), AppError> {
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegSetKeyValueW, HKEY_LOCAL_MACHINE, REG_EXPAND_SZ,
    };

    let subkey = wide_null("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
    let value_name = wide_null(name);
    let data = wide_null(value);
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value_name.as_ptr(),
            REG_EXPAND_SZ,
            data.as_ptr().cast(),
            (data.len() * std::mem::size_of::<u16>()) as u32,
        )
    };

    if status == ERROR_SUCCESS {
        notify_environment_changed();
        return Ok(());
    }

    let reason = if status == ERROR_ACCESS_DENIED {
        "access denied; run Nova as administrator to update system environment variables"
            .to_string()
    } else {
        format!("Windows error {status}")
    };
    Err(AppError::Config(format!(
        "failed to update system environment variable {name}: {reason}"
    )))
}

#[cfg(windows)]
fn can_write_system_env() -> bool {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY_LOCAL_MACHINE, KEY_SET_VALUE,
    };

    let subkey = wide_null("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
    let mut key = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if status == ERROR_SUCCESS {
        unsafe {
            RegCloseKey(key);
        }
        true
    } else {
        false
    }
}

#[cfg(not(windows))]
fn set_user_env(name: &str, value: &str) -> Result<(), AppError> {
    std::env::set_var(name, value);
    Ok(())
}

#[cfg(not(windows))]
fn can_write_system_env() -> bool {
    false
}

#[cfg(not(windows))]
fn set_system_env(name: &str, _value: &str) -> Result<(), AppError> {
    Err(AppError::Config(format!(
        "system environment variable updates are not supported on this platform: {name}"
    )))
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn notify_environment_changed() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    let environment = wide_null("Environment");
    let mut result = 0usize;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            environment.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        );
    }
}
