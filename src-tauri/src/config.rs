use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Application configuration stored in the user's .nova directory.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(rename = "jvm")]
    #[serde(default)]
    pub jvm: JvmConfig,
    #[serde(default)]
    pub maven: MavenConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JvmConfig {
    /// Whether the first-time setup has been completed
    #[serde(default)]
    pub setup_done: bool,

    /// JDK installation directory, defaults to ~/.nova/versions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub versions_dir: Option<String>,

    /// Symlink path, defaults to ~/.nova/current
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_path: Option<String>,

    /// Default download source: "corretto" | "adoptium" | "zulu"
    #[serde(default = "default_source")]
    pub default_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MavenConfig {
    /// Maven installation directory, defaults to ~/.nova/maven/versions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub versions_dir: Option<String>,

    /// Maven symlink path, defaults to ~/.nova/maven/current
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_path: Option<String>,

    /// Maven settings.xml path, defaults to ~/.m2/settings.xml
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_path: Option<String>,

    /// Maven local repository path written into settings.xml
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_repository: Option<String>,

    /// Maven mirror entries written into settings.xml
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mirrors: Vec<MavenMirrorConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MavenMirrorConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub mirror_of: String,
}

fn default_source() -> String {
    "tsinghua".to_string()
}

impl Default for JvmConfig {
    fn default() -> Self {
        Self {
            setup_done: false,
            versions_dir: None,
            symlink_path: None,
            default_source: default_source(),
        }
    }
}

impl Config {
    /// Get the base directory for all JVM data.
    pub fn base_dir() -> PathBuf {
        dirs::home_dir()
            .or_else(dirs::data_dir)
            .expect("cannot determine user data directory")
            .join(".nova")
    }

    /// Get the actual versions directory path (custom or default)
    pub fn versions_dir(&self) -> PathBuf {
        self.jvm
            .versions_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| Self::base_dir().join("versions"))
    }

    /// Get the actual symlink path (custom or default)
    pub fn symlink_path(&self) -> PathBuf {
        self.jvm
            .symlink_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| Self::base_dir().join("current"))
    }

    /// Get the actual Maven versions directory path (custom or default)
    pub fn maven_versions_dir(&self) -> PathBuf {
        self.maven
            .versions_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| Self::base_dir().join("maven").join("versions"))
    }

    /// Get the actual Maven symlink path (custom or default)
    pub fn maven_symlink_path(&self) -> PathBuf {
        self.maven
            .symlink_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| Self::base_dir().join("maven").join("current"))
    }

    /// Get the configured Maven settings.xml path (custom or default)
    pub fn maven_settings_path(&self) -> PathBuf {
        self.maven
            .settings_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .or_else(dirs::data_dir)
                    .expect("cannot determine user data directory")
                    .join(".m2")
                    .join("settings.xml")
            })
    }

    /// Get the cache directory path for Maven archives
    pub fn maven_cache_dir() -> PathBuf {
        Self::cache_dir().join("maven")
    }

    /// Get the cache directory path
    pub fn cache_dir() -> PathBuf {
        Self::base_dir().join("cache")
    }

    /// Get the config file path
    pub fn config_path() -> PathBuf {
        Self::base_dir().join("config.toml")
    }

    /// Load config from disk, return default if file doesn't exist
    pub fn load() -> Result<Self> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read config: {}", path.display()))?;
        let config: Config = toml::from_str(&content)
            .with_context(|| format!("failed to parse config: {}", path.display()))?;
        Ok(config)
    }

    /// Save config to disk
    pub fn save(&self) -> Result<()> {
        let base = Self::base_dir();
        fs::create_dir_all(&base)
            .with_context(|| format!("failed to create base dir: {}", base.display()))?;

        let content = toml::to_string_pretty(self).context("failed to serialize config")?;
        let path = Self::config_path();
        fs::write(&path, content)
            .with_context(|| format!("failed to write config: {}", path.display()))?;
        Ok(())
    }

    /// Ensure the required directory structure exists
    pub fn ensure_dirs(&self) -> Result<()> {
        let versions = self.versions_dir();
        let maven_versions = self.maven_versions_dir();
        let cache = Self::cache_dir();
        let maven_cache = Self::maven_cache_dir();

        fs::create_dir_all(&versions)
            .with_context(|| format!("failed to create versions dir: {}", versions.display()))?;
        fs::create_dir_all(&maven_versions).with_context(|| {
            format!(
                "failed to create Maven versions dir: {}",
                maven_versions.display()
            )
        })?;
        fs::create_dir_all(&cache)
            .with_context(|| format!("failed to create cache dir: {}", cache.display()))?;
        fs::create_dir_all(&maven_cache)
            .with_context(|| format!("failed to create cache dir: {}", maven_cache.display()))?;
        Ok(())
    }
}
