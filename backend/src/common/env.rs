//! Typed environment variable parsing utilities

use std::str::FromStr;

/// Read an env var and parse it, falling back to `default` on missing or parse failure.
pub fn env_or<T: FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Read an env var as a boolean. Recognises `"1"` and `"true"` (case-insensitive).
pub fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => v == "1" || v.eq_ignore_ascii_case("true"),
        Err(_) => default,
    }
}

/// Read an env var as a string, falling back to `default`.
pub fn env_string(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
