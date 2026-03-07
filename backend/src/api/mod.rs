//! API Layer Module
//!
//! HTTP server, routes, middleware, and WebSocket handlers.

pub mod middleware;
pub mod routes;
pub mod server;
pub mod websocket;

// Re-exports for convenience
pub use middleware::{RateLimiter, RateLimitState, ValidationError};
pub use server::{AppState, SharedAppState};
