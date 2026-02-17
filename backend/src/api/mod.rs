//! API Layer Module
//!
//! HTTP server, routes, middleware, and WebSocket handlers.
//!
//! Note: Currently re-exports from the legacy api.rs and deposit_tracker/api.rs.
//! In a future refactor, these would be consolidated into api/routes/.

pub mod middleware;
pub mod routes;
pub mod server;
pub mod websocket;

// Re-exports for convenience
pub use middleware::{RateLimiter, RateLimitState, ValidationError};
pub use server::{AppState, SharedAppState};
