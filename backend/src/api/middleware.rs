//! API Middleware - Input Validation and Rate Limiting
//!
//! Provides security middleware for the zVault API:
//! - Input validation for request parameters
//! - Rate limiting per IP/API key
//! - Request size limits
//! - Security headers

use axum::{
    extract::Request,
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

// ============================================================================
// Rate Limiting
// ============================================================================

/// Rate limiter configuration
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    /// Maximum requests per window
    pub max_requests: u32,
    /// Time window duration
    pub window: Duration,
    /// Burst allowance (extra requests allowed temporarily)
    pub burst: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_requests: 100,             // 100 requests
            window: Duration::from_secs(60), // per minute
            burst: 20,                     // allow 20 extra in bursts
        }
    }
}

impl RateLimitConfig {
    /// Stricter config for sensitive endpoints
    pub fn strict() -> Self {
        Self {
            max_requests: 10,
            window: Duration::from_secs(60),
            burst: 5,
        }
    }

    /// More lenient config for read-only endpoints
    pub fn lenient() -> Self {
        Self {
            max_requests: 500,
            window: Duration::from_secs(60),
            burst: 100,
        }
    }
}

/// Rate limit entry for a single client
#[derive(Debug, Clone)]
struct RateLimitEntry {
    /// Number of requests in current window
    count: u32,
    /// Window start time
    window_start: Instant,
    /// Burst tokens available
    burst_tokens: u32,
}

/// In-memory rate limiter
pub struct RateLimiter {
    config: RateLimitConfig,
    entries: RwLock<HashMap<String, RateLimitEntry>>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            entries: RwLock::new(HashMap::new()),
        }
    }

    /// Check if a request is allowed for the given client ID
    pub async fn check(&self, client_id: &str) -> Result<(), RateLimitError> {
        let mut entries = self.entries.write().await;
        let now = Instant::now();

        let entry = entries.entry(client_id.to_string()).or_insert(RateLimitEntry {
            count: 0,
            window_start: now,
            burst_tokens: self.config.burst,
        });

        // Check if window has expired
        if now.duration_since(entry.window_start) >= self.config.window {
            // Reset window
            entry.count = 0;
            entry.window_start = now;
            entry.burst_tokens = self.config.burst.min(entry.burst_tokens + 5); // Slowly replenish burst
        }

        // Check limits
        if entry.count < self.config.max_requests {
            entry.count += 1;
            Ok(())
        } else if entry.burst_tokens > 0 {
            entry.burst_tokens -= 1;
            entry.count += 1;
            Ok(())
        } else {
            let retry_after = self.config.window.as_secs()
                - now.duration_since(entry.window_start).as_secs();
            Err(RateLimitError::Exceeded { retry_after })
        }
    }

    /// Clean up old entries (call periodically)
    pub async fn cleanup(&self) {
        let mut entries = self.entries.write().await;
        let now = Instant::now();
        let expiry = self.config.window * 2;

        entries.retain(|_, entry| now.duration_since(entry.window_start) < expiry);
    }
}

#[derive(Debug)]
pub enum RateLimitError {
    Exceeded { retry_after: u64 },
}

// ============================================================================
// Input Validation
// ============================================================================

/// Validation result
#[derive(Debug)]
pub struct ValidationResult {
    pub is_valid: bool,
    pub errors: Vec<String>,
}

impl ValidationResult {
    pub fn ok() -> Self {
        Self {
            is_valid: true,
            errors: vec![],
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            is_valid: false,
            errors: vec![msg.into()],
        }
    }

    pub fn merge(mut self, other: Self) -> Self {
        self.is_valid = self.is_valid && other.is_valid;
        self.errors.extend(other.errors);
        self
    }
}

/// Validate a Bitcoin address
pub fn validate_btc_address(address: &str) -> ValidationResult {
    // Basic length check
    if address.is_empty() {
        return ValidationResult::error("BTC address is required");
    }

    if address.len() < 26 || address.len() > 90 {
        return ValidationResult::error("Invalid BTC address length");
    }

    // Check valid prefixes for mainnet and testnet
    let valid_prefixes = [
        "1",     // P2PKH mainnet
        "3",     // P2SH mainnet
        "bc1",   // Bech32 mainnet
        "m",     // P2PKH testnet
        "n",     // P2PKH testnet
        "2",     // P2SH testnet
        "tb1",   // Bech32 testnet
        "bcrt1", // Bech32 regtest
    ];

    if !valid_prefixes.iter().any(|p| address.starts_with(p)) {
        return ValidationResult::error(format!(
            "Invalid BTC address prefix. Must start with one of: {}",
            valid_prefixes.join(", ")
        ));
    }

    // Check for invalid characters
    let valid_chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if address.starts_with("bc1") || address.starts_with("tb1") || address.starts_with("bcrt1") {
        // Bech32 uses lowercase only after prefix
        let suffix = if address.starts_with("bcrt1") {
            &address[5..]
        } else if address.starts_with("bc1") || address.starts_with("tb1") {
            &address[4..]
        } else {
            address
        };
        if suffix.chars().any(|c| !c.is_ascii_alphanumeric()) {
            return ValidationResult::error("Invalid characters in Bech32 address");
        }
    } else {
        // Base58 check
        if address.chars().any(|c| !valid_chars.contains(c)) {
            return ValidationResult::error("Invalid characters in Base58 address");
        }
    }

    ValidationResult::ok()
}

/// Validate a Solana address (base58 public key)
pub fn validate_solana_address(address: &str) -> ValidationResult {
    if address.is_empty() {
        return ValidationResult::error("Solana address is required");
    }

    // Solana addresses are 32 bytes = 44 base58 characters
    if address.len() < 32 || address.len() > 44 {
        return ValidationResult::error("Invalid Solana address length");
    }

    // Base58 character set (no 0, O, I, l)
    let valid_chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if address.chars().any(|c| !valid_chars.contains(c)) {
        return ValidationResult::error("Invalid characters in Solana address");
    }

    ValidationResult::ok()
}

/// Validate amount in satoshis
pub fn validate_amount_sats(amount: u64, min: u64, max: u64) -> ValidationResult {
    if amount == 0 {
        return ValidationResult::error("Amount must be greater than 0");
    }

    if amount < min {
        return ValidationResult::error(format!("Amount must be at least {} satoshis", min));
    }

    if amount > max {
        return ValidationResult::error(format!("Amount must not exceed {} satoshis", max));
    }

    ValidationResult::ok()
}

/// Validate hex string
pub fn validate_hex(input: &str, expected_len: Option<usize>, field_name: &str) -> ValidationResult {
    if input.is_empty() {
        return ValidationResult::error(format!("{} is required", field_name));
    }

    // Remove 0x prefix if present
    let hex_str = input.strip_prefix("0x").unwrap_or(input);

    // Check valid hex characters
    if !hex_str.chars().all(|c| c.is_ascii_hexdigit()) {
        return ValidationResult::error(format!("{} must be valid hex", field_name));
    }

    // Check length if specified
    if let Some(len) = expected_len {
        if hex_str.len() != len * 2 {
            return ValidationResult::error(format!(
                "{} must be {} bytes ({} hex characters)",
                field_name,
                len,
                len * 2
            ));
        }
    }

    ValidationResult::ok()
}

// ============================================================================
// Middleware Types
// ============================================================================

/// Shared rate limiter state
pub type RateLimitState = Arc<RateLimiter>;

/// Create a new rate limiter with default config
pub fn create_rate_limiter() -> RateLimitState {
    Arc::new(RateLimiter::new(RateLimitConfig::default()))
}

/// Extract client IP from request headers
pub fn extract_client_ip(headers: &HeaderMap) -> Option<String> {
    // Try X-Forwarded-For first (for proxied requests)
    if let Some(forwarded) = headers.get("x-forwarded-for") {
        if let Ok(value) = forwarded.to_str() {
            // Take the first IP in the chain
            return Some(value.split(',').next()?.trim().to_string());
        }
    }

    // Try X-Real-IP
    if let Some(real_ip) = headers.get("x-real-ip") {
        if let Ok(value) = real_ip.to_str() {
            return Some(value.to_string());
        }
    }

    None
}

/// Error response for API errors
#[derive(Serialize)]
pub struct ValidationError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl IntoResponse for ValidationError {
    fn into_response(self) -> Response {
        let status = if self.code.as_deref() == Some("RATE_LIMITED") {
            StatusCode::TOO_MANY_REQUESTS
        } else if self.code.as_deref() == Some("VALIDATION_ERROR") {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };

        (status, Json(self)).into_response()
    }
}

/// Rate limiting middleware
pub async fn rate_limit_middleware(
    headers: HeaderMap,
    rate_limiter: RateLimitState,
    request: Request,
    next: Next,
) -> Result<Response, ValidationError> {
    // Extract client identifier
    let client_id = extract_client_ip(&headers).unwrap_or_else(|| "unknown".to_string());

    // Check rate limit
    match rate_limiter.check(&client_id).await {
        Ok(()) => Ok(next.run(request).await),
        Err(RateLimitError::Exceeded { retry_after }) => Err(ValidationError {
            error: "Rate limit exceeded".to_string(),
            code: Some("RATE_LIMITED".to_string()),
            details: vec![],
            retry_after: Some(retry_after),
        }),
    }
}

/// Security headers middleware
pub async fn security_headers_middleware(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    // Add security headers
    headers.insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    headers.insert("X-Frame-Options", "DENY".parse().unwrap());
    headers.insert("X-XSS-Protection", "1; mode=block".parse().unwrap());
    headers.insert(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains".parse().unwrap(),
    );
    headers.insert(
        "Content-Security-Policy",
        "default-src 'self'".parse().unwrap(),
    );

    response
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_btc_address_validation() {
        // Valid addresses
        assert!(validate_btc_address("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2").is_valid);
        assert!(validate_btc_address("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").is_valid);
        assert!(validate_btc_address("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").is_valid);
        assert!(validate_btc_address("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx").is_valid);

        // Invalid addresses
        assert!(!validate_btc_address("").is_valid);
        assert!(!validate_btc_address("invalid").is_valid);
        assert!(!validate_btc_address("0xinvalid").is_valid);
    }

    #[test]
    fn test_solana_address_validation() {
        // Valid address
        assert!(validate_solana_address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").is_valid);

        // Invalid addresses
        assert!(!validate_solana_address("").is_valid);
        assert!(!validate_solana_address("short").is_valid);
        assert!(!validate_solana_address("invalid_with_underscore").is_valid);
    }

    #[test]
    fn test_amount_validation() {
        assert!(validate_amount_sats(1000, 100, 1_000_000).is_valid);
        assert!(!validate_amount_sats(0, 100, 1_000_000).is_valid);
        assert!(!validate_amount_sats(50, 100, 1_000_000).is_valid);
        assert!(!validate_amount_sats(2_000_000, 100, 1_000_000).is_valid);
    }

    #[test]
    fn test_hex_validation() {
        assert!(validate_hex("abcdef1234", None, "test").is_valid);
        assert!(validate_hex("0xabcdef1234", None, "test").is_valid);
        assert!(validate_hex(
            "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            Some(32),
            "test"
        )
        .is_valid);

        assert!(!validate_hex("", None, "test").is_valid);
        assert!(!validate_hex("ghijk", None, "test").is_valid);
        assert!(!validate_hex("abcd", Some(32), "test").is_valid);
    }

    #[tokio::test]
    async fn test_rate_limiter() {
        let config = RateLimitConfig {
            max_requests: 3,
            window: Duration::from_secs(1),
            burst: 1,
        };
        let limiter = RateLimiter::new(config);

        // First 3 requests should succeed
        assert!(limiter.check("client1").await.is_ok());
        assert!(limiter.check("client1").await.is_ok());
        assert!(limiter.check("client1").await.is_ok());

        // 4th uses burst
        assert!(limiter.check("client1").await.is_ok());

        // 5th should fail
        assert!(limiter.check("client1").await.is_err());

        // Different client should succeed
        assert!(limiter.check("client2").await.is_ok());
    }
}
