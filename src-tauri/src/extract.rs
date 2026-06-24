use std::fs;
use std::path::Path;

use crate::error::AppError;

// ZIP bomb protection limits
const MAX_SINGLE_FILE_SIZE: u64 = 500 * 1024 * 1024; // 500MB
const MAX_TOTAL_SIZE: u64 = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_FILE_COUNT: usize = 10_000;

/// Extract a zip archive to the given destination directory.
/// Returns the path to the extracted top-level directory.
pub fn extract_zip(archive: &Path, dest: &Path) -> Result<std::path::PathBuf, AppError> {
    let file = fs::File::open(archive).map_err(|e| {
        AppError::Extraction(format!("failed to open archive {}: {e}", archive.display()))
    })?;

    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        AppError::Extraction(format!("failed to read zip {}: {e}", archive.display()))
    })?;

    // Determine top-level directory from first entry
    let top_dir = {
        let first = archive
            .by_index(0)
            .map_err(|e| AppError::Extraction(format!("zip read error: {e}")))?;
        let name = first.name();
        // e.g., "jdk-21.0.11/" -> "jdk-21.0.11"
        name.trim_end_matches('/')
            .split('/')
            .next()
            .unwrap_or("jdk")
            .to_string()
    };

    let extract_dest = dest.to_path_buf();
    fs::create_dir_all(&extract_dest).map_err(|e| {
        AppError::Extraction(format!(
            "failed to create dest dir {}: {e}",
            extract_dest.display()
        ))
    })?;

    let file_count = archive.len();
    if file_count > MAX_FILE_COUNT {
        return Err(AppError::Extraction(format!(
            "zip contains too many files: {} (max {})",
            file_count, MAX_FILE_COUNT
        )));
    }

    let mut total_extracted_size: u64 = 0;

    for i in 0..file_count {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Extraction(format!("zip entry {i} error: {e}")))?;

        let enclosed_path = match entry.enclosed_name() {
            Some(path) => path,
            None => continue,
        };

        let out_path = extract_dest.join(&enclosed_path);

        // Validate path is within destination (Zip Slip protection)
        // enclosed_name() already prevents absolute paths and ".." components,
        // but we add an extra check to ensure the result is within extract_dest
        if out_path.strip_prefix(&extract_dest).is_err() {
            return Err(AppError::Extraction(format!(
                "path traversal attempt detected: {} outside of {}",
                out_path.display(),
                extract_dest.display()
            )));
        }

        // Check single file size limit
        let entry_size = entry.size();
        if entry_size > MAX_SINGLE_FILE_SIZE {
            return Err(AppError::Extraction(format!(
                "file too large: {} bytes (max {} bytes)",
                entry_size, MAX_SINGLE_FILE_SIZE
            )));
        }

        // Check total size limit
        total_extracted_size += entry_size;
        if total_extracted_size > MAX_TOTAL_SIZE {
            return Err(AppError::Extraction(format!(
                "total extraction size too large: {} bytes (max {} bytes)",
                total_extracted_size, MAX_TOTAL_SIZE
            )));
        }

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| AppError::Extraction(format!("mkdir {}: {e}", out_path.display())))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    AppError::Extraction(format!("mkdir parent {}: {e}", parent.display()))
                })?;
            }

            let mut outfile = fs::File::create(&out_path).map_err(|e| {
                AppError::Extraction(format!("create file {}: {e}", out_path.display()))
            })?;

            std::io::copy(&mut entry, &mut outfile).map_err(|e| {
                AppError::Extraction(format!("write file {}: {e}", out_path.display()))
            })?;
        }
    }

    Ok(extract_dest.join(&top_dir))
}
