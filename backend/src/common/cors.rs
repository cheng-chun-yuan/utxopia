//! Shared CORS configuration
//!
//! Reads `ALLOWED_ORIGIN` from the environment and builds a CorsLayer.
//! Falls back to `http://localhost:3000` when the variable is unset.

use tower_http::cors::{AllowOrigin, Any, CorsLayer};

/// Build a `CorsLayer` from the `ALLOWED_ORIGIN` environment variable.
///
/// Supports comma-separated origins (e.g. `https://a.com,https://b.com`).
/// Falls back to `http://localhost:3000` when unset or empty.
pub fn cors_from_env() -> CorsLayer {
    match std::env::var("ALLOWED_ORIGIN") {
        Ok(origin) if !origin.is_empty() => {
            let origins: Vec<_> = origin
                .split(',')
                .filter_map(|o| o.trim().parse().ok())
                .collect();
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods(Any)
                .allow_headers(Any)
        }
        _ => {
            tracing::warn!(
                "ALLOWED_ORIGIN not set — defaulting to localhost:3000 (set ALLOWED_ORIGIN for production)"
            );
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(vec![
                    "http://localhost:3000".parse().unwrap(),
                ]))
                .allow_methods(Any)
                .allow_headers(Any)
        }
    }
}
