use std::fmt;

/// JDK version representation (e.g., "21.0.11", "17.0.19")
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct JdkVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl JdkVersion {
    /// Parse a version string like "21.0.11" or "21"
    pub fn parse(s: &str) -> Result<Self, String> {
        let trimmed = s.trim();

        // Handle empty string
        if trimmed.is_empty() {
            return Err("empty version string".to_string());
        }

        let parts: Vec<&str> = trimmed.split('.').collect();

        // Need at least major version
        if parts.is_empty() || parts[0].is_empty() {
            return Err(format!("invalid major version: {s}"));
        }

        let major = parts[0]
            .parse::<u32>()
            .map_err(|_| format!("invalid major version: {s}"))?;

        let minor = parts
            .get(1)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        let patch = parts
            .get(2)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);

        Ok(Self {
            major,
            minor,
            patch,
        })
    }
}

impl fmt::Display for JdkVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}
