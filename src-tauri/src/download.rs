use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use tauri::Emitter;

use crate::config::Config;
use crate::error::AppError;

// Maximum download size limit (2GB)
const MAX_DOWNLOAD_SIZE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadState {
    Running,
    Paused,
    Cancelled,
}

static DOWNLOAD_STATES: OnceLock<Mutex<std::collections::HashMap<String, DownloadState>>> =
    OnceLock::new();

/// Download a file with progress reporting via Tauri events
pub fn download_file(
    url: &str,
    file_name: &str,
    task_id: &str,
    app_handle: &tauri::AppHandle,
) -> Result<std::path::PathBuf, AppError> {
    register_download(task_id);
    let _guard = DownloadGuard {
        task_id: task_id.to_string(),
    };
    let cache_dir = Config::cache_dir();
    fs::create_dir_all(&cache_dir)
        .map_err(|e| AppError::Extraction(format!("failed to create cache dir: {e}")))?;

    let dest = cache_dir.join(file_name);
    let temp_dest = dest.with_extension("download");

    // Check if already cached
    if dest.exists() {
        let cached_size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        let _ = app_handle.emit(
            "download-progress",
            serde_json::json!({
                "percent": 100,
                "status": "Using cached archive",
                "task_id": task_id,
                "speed": "0 B/s",
                "speed_bytes": 0.0,
                "total_size": cached_size,
                "downloaded": cached_size,
            }),
        );
        finish_download(task_id);
        return Ok(dest);
    }

    if let Err(e) = fs::remove_file(&temp_dest) {
        eprintln!("Failed to remove temp file: {}", e);
    }

    let resp = crate::provider::http_client()
        .get(url)
        .header("User-Agent", "nova-jdk-manager/1.0")
        .send()
        .map_err(|e| AppError::Network(e))?;

    if !resp.status().is_success() {
        return Err(AppError::Provider(format!(
            "download failed: HTTP {}",
            resp.status()
        )));
    }

    let total_size: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // Enforce maximum download size limit
    if total_size > MAX_DOWNLOAD_SIZE {
        return Err(AppError::Extraction(format!(
            "download too large: {} bytes (max {} bytes)",
            total_size, MAX_DOWNLOAD_SIZE
        )));
    }

    let mut file = fs::File::create(&temp_dest)
        .map_err(|e| AppError::Extraction(format!("failed to create file: {e}")))?;

    let mut downloaded: u64 = 0;
    let mut reader = resp;
    let mut buffer = [0u8; 65536];
    let mut last_emit_time = Instant::now();
    let mut bytes_since_last_emit: u64 = 0;

    // Emit initial progress (0%)
    let _ = app_handle.emit(
        "download-progress",
        serde_json::json!({
            "percent": 0,
            "status": "准备下载...",
            "task_id": task_id,
            "speed": "0 B/s",
            "speed_bytes": 0.0,
            "total_size": total_size,
            "downloaded": 0_u64,
        }),
    );

    loop {
        wait_until_running(task_id, &temp_dest)?;

        let bytes_read = match reader.read(&mut buffer) {
            Ok(n) => n,
            Err(e) => {
                if let Err(e) = fs::remove_file(&temp_dest) {
                    eprintln!("Failed to remove temp file: {}", e);
                }
                return Err(AppError::Extraction(format!("download read error: {e}")));
            }
        };

        if bytes_read == 0 {
            break;
        }

        wait_until_running(task_id, &temp_dest)?;

        if let Err(e) = file.write_all(&buffer[..bytes_read]) {
            if let Err(e) = fs::remove_file(&temp_dest) {
                eprintln!("Failed to remove temp file: {}", e);
            }
            return Err(AppError::Extraction(format!("download write error: {e}")));
        }

        // Safely convert bytes_read (usize) to u64 for 32/64-bit compatibility
        // read() returns usize, buffer size is 8192, so bytes_read <= 8192
        let bytes_read_u64: u64 = bytes_read.try_into().unwrap_or(0);

        downloaded = downloaded.saturating_add(bytes_read_u64);
        bytes_since_last_emit = bytes_since_last_emit.saturating_add(bytes_read_u64);

        let now = Instant::now();
        let elapsed = now.duration_since(last_emit_time);

        // Calculate percentage if total size is known
        let percent = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u32
        } else {
            0
        };

        // Emit progress every 200ms
        if elapsed.as_millis() >= 200 || (total_size > 0 && percent == 100) {
            let elapsed_secs = elapsed.as_secs_f64();
            let speed = if elapsed_secs > 0.0 {
                bytes_since_last_emit as f64 / elapsed_secs
            } else {
                0.0
            };

            let speed_str = format_speed(speed);

            if let Err(e) = app_handle.emit(
                "download-progress",
                serde_json::json!({
                    "percent": percent,
                    "status": format!("{}%", percent),
                    "task_id": task_id,
                    "speed": speed_str,
                    "speed_bytes": speed,
                    "total_size": total_size,
                    "downloaded": downloaded,
                }),
            ) {
                eprintln!("Failed to emit download progress: {}", e);
            }

            last_emit_time = now;
            bytes_since_last_emit = 0;
        }
    }

    drop(file);
    fs::rename(&temp_dest, &dest).map_err(|e| {
        if let Err(err) = fs::remove_file(&temp_dest) {
            eprintln!("Failed to remove temp file: {}", err);
        }
        AppError::Extraction(format!("failed to finalize download: {e}"))
    })?;

    let _ = app_handle.emit(
        "download-progress",
        serde_json::json!({
            "percent": 100,
            "status": "Download complete",
            "task_id": task_id,
            "speed": "0 B/s",
            "speed_bytes": 0.0,
            "total_size": total_size,
            "downloaded": total_size,
        }),
    );

    finish_download(task_id);
    Ok(dest)
}

/// Format speed in bytes per second to human readable format
fn format_speed(bytes_per_second: f64) -> String {
    if bytes_per_second < 1024.0 {
        format!("{:.0} B/s", bytes_per_second)
    } else if bytes_per_second < 1024.0 * 1024.0 {
        format!("{:.1} KB/s", bytes_per_second / 1024.0)
    } else if bytes_per_second < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} MB/s", bytes_per_second / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB/s", bytes_per_second / (1024.0 * 1024.0 * 1024.0))
    }
}

pub fn prepare_download(task_id: &str) {
    register_download(task_id);
}

pub fn clear_download(task_id: &str) {
    finish_download(task_id);
}

pub fn pause_download(task_id: &str) {
    set_download_state(task_id, DownloadState::Paused);
}

pub fn resume_download(task_id: &str) {
    set_download_state(task_id, DownloadState::Running);
}

pub fn cancel_download(task_id: &str) {
    set_download_state(task_id, DownloadState::Cancelled);
}

fn register_download(task_id: &str) {
    let mut states = download_states().lock().unwrap();
    states
        .entry(task_id.to_string())
        .or_insert(DownloadState::Running);
}

fn finish_download(task_id: &str) {
    let mut states = download_states().lock().unwrap();
    states.remove(task_id);
}

fn set_download_state(task_id: &str, state: DownloadState) {
    let mut states = download_states().lock().unwrap();
    states.insert(task_id.to_string(), state);
}

fn wait_until_running(task_id: &str, temp_dest: &Path) -> Result<(), AppError> {
    loop {
        match current_download_state(task_id) {
            Some(DownloadState::Running) => return Ok(()),
            Some(DownloadState::Paused) => std::thread::sleep(Duration::from_millis(500)),
            Some(DownloadState::Cancelled) => {
                let _ = fs::remove_file(temp_dest);
                finish_download(task_id);
                return Err(AppError::Extraction("download cancelled".to_string()));
            }
            None => return Ok(()),
        }
    }
}

fn current_download_state(task_id: &str) -> Option<DownloadState> {
    let states = download_states().lock().unwrap();
    states.get(task_id).copied()
}

fn download_states() -> &'static Mutex<std::collections::HashMap<String, DownloadState>> {
    DOWNLOAD_STATES.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

struct DownloadGuard {
    task_id: String,
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        finish_download(&self.task_id);
    }
}

/// Verify SHA-256 checksum of a file
pub fn verify_checksum(path: &Path, expected: &str) -> Result<bool, AppError> {
    let mut file = fs::File::open(path)
        .map_err(|e| AppError::Extraction(format!("open for checksum: {e}")))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| AppError::Extraction(format!("checksum read error: {e}")))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let result = hasher.finalize();
    let actual = format!("{:x}", result);
    Ok(actual == expected.to_lowercase())
}
