use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Create a symlink/junction at `link` pointing to `target`.
/// On Windows: tries symlink_dir first, falls back to junction.
/// On Unix: uses std::os::unix::fs::symlink.
pub fn create(target: &Path, link: &Path) -> Result<(), AppError> {
    // Check if target exists first
    if !target.exists() {
        return Err(AppError::Symlink(format!(
            "target does not exist: {}",
            target.display()
        )));
    }

    // Remove existing link if present
    if link_exists(link) {
        remove(link)?;
    }

    // Ensure parent directory exists
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AppError::Symlink(format!(
                "failed to create parent dir {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    symlink_inner(target, link)
}

/// Update an existing symlink to point to a new target
pub fn update(target: &Path, link: &Path) -> Result<(), AppError> {
    // Check if target exists first
    if !target.exists() {
        return Err(AppError::Symlink(format!(
            "target does not exist: {}",
            target.display()
        )));
    }

    remove(link)?;
    symlink_inner(target, link)
}

/// Remove a symlink/junction at `link`
pub fn remove(link: &Path) -> Result<(), AppError> {
    if !link_exists(link) {
        return Ok(());
    }

    #[cfg(windows)]
    {
        // On Windows, junctions are directories and must be removed with remove_dir
        // Symlinks to directories can be removed with remove_dir
        if link.is_dir() || is_junction(link) {
            remove_link_dir(link)
        } else {
            match fs::remove_file(link) {
                Ok(()) => Ok(()),
                Err(_) => remove_link_dir(link),
            }
        }
    }

    #[cfg(not(windows))]
    {
        std::fs::remove_file(link).map_err(|e| {
            AppError::Symlink(format!("failed to remove link {}: {}", link.display(), e))
        })
    }
}

/// Read the target of a symlink/junction
pub fn read_link(link: &Path) -> Result<Option<PathBuf>, AppError> {
    if !link_exists(link) {
        return Ok(None);
    }

    #[cfg(windows)]
    {
        // On Windows, try reading as symlink first, then check junction
        match std::fs::symlink_metadata(link) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    fs::read_link(link)
                        .map(Some)
                        .map_err(|e| AppError::Symlink(format!("read_link failed: {e}")))
                } else if meta.is_dir() {
                    // Could be a junction — check via fsutil or accept it
                    Ok(Some(
                        fs::canonicalize(link).unwrap_or_else(|_| link.to_path_buf()),
                    ))
                } else {
                    Ok(None)
                }
            }
            Err(e) => Err(AppError::Symlink(format!(
                "symlink_metadata failed for {}: {e}",
                link.display()
            ))),
        }
    }

    #[cfg(not(windows))]
    {
        fs::read_link(link)
            .map(Some)
            .map_err(|e| AppError::Symlink(format!("read_link failed: {e}")))
    }
}

pub fn is_link(path: &Path) -> bool {
    is_symlink(path) || is_junction(path)
}

/// Platform-specific symlink creation with junction fallback on Windows
#[cfg(windows)]
fn symlink_inner(target: &Path, link: &Path) -> Result<(), AppError> {
    match std::os::windows::fs::symlink_dir(target, link) {
        Ok(()) => Ok(()),
        Err(_) => create_junction(target, link),
    }
}

#[cfg(not(windows))]
fn symlink_inner(target: &Path, link: &Path) -> Result<(), AppError> {
    std::os::unix::fs::symlink(target, link).map_err(|e| {
        AppError::Symlink(format!(
            "failed to create symlink {} -> {}: {}",
            link.display(),
            target.display(),
            e
        ))
    })
}

/// Create a Windows junction (directory reparse point)
#[cfg(windows)]
fn create_junction(target: &Path, link: &Path) -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    if !target.exists() {
        return Err(AppError::Symlink(format!(
            "target does not exist: {}",
            target.display()
        )));
    }

    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::Symlink(format!("failed to run mklink /J: {e}")))?;

    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::Symlink(format!(
        "mklink /J failed for {} -> {}: {}{}",
        link.display(),
        target.display(),
        stdout,
        stderr
    )))
}

/// Check if path is a junction (Windows-only, always false on other platforms)
#[cfg(windows)]
fn is_junction(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            // FILE_ATTRIBUTE_REPARSE_POINT = 0x400
            meta.file_attributes() & 0x400 != 0 && meta.is_dir()
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn is_junction(_path: &Path) -> bool {
    false
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn link_exists(path: &Path) -> bool {
    path.exists() || fs::symlink_metadata(path).is_ok() || is_junction(path)
}

#[cfg(windows)]
fn remove_link_dir(link: &Path) -> Result<(), AppError> {
    fs::remove_dir(link)
        .map_err(|e| AppError::Symlink(format!("failed to remove link {}: {}", link.display(), e)))
}
