//! API Layer Module
//!
//! HTTP server, routes, middleware, and WebSocket handlers.

pub mod middleware;

// Re-exports for convenience
pub use middleware::{RateLimiter, RateLimitState, ValidationError};
