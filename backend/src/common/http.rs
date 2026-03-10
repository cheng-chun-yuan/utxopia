//! Shared HTTP client builder

use reqwest::Client;
use std::time::Duration;

/// Build a default `reqwest::Client` with a 15-second timeout.
pub fn default_http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Build a `reqwest::Client` with a custom timeout.
pub fn http_client_with_timeout(timeout: Duration) -> Client {
    Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| Client::new())
}
