//! Deposit Tracker API Endpoints
//!
//! REST and WebSocket endpoints for deposit tracking:
//! - GET /api/deposits/{id} - Get deposit status
//! - GET /api/deposits - List all deposits
//! - GET /api/pool/info - Pool config for SDK
//! - WS /ws/deposits/{id} - Subscribe to status updates
//! - WS /ws/deposits - Subscribe to all updates
//!
//! Deposits are auto-detected via block scanning (no registration API needed).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::api::middleware::{api_key_auth_middleware, create_rate_limiter, rate_limit_middleware};
use super::service::DepositTrackerService;
use super::types::DepositStatusResponse;
use super::websocket::{
    create_ws_state, ws_all_deposits_handler, ws_deposit_handler, SharedWebSocketState,
};

/// Combined application state
pub struct AppState {
    pub tracker: Arc<RwLock<DepositTrackerService>>,
    pub ws_state: SharedWebSocketState,
    /// Pool group public key (x-only, hex-encoded)
    pub group_pubkey: String,
    /// Bitcoin network ("testnet" | "mainnet")
    pub bitcoin_network: String,
}

/// Shared app state type
pub type SharedAppState = Arc<AppState>;

/// Create the deposit tracker API router
pub fn create_deposit_router(tracker: DepositTrackerService) -> Router {
    let ws_state = create_ws_state();
    let tracker_with_ws = tracker.with_websocket(ws_state.clone());

    // Get pool group pubkey from sweeper if available
    let group_pubkey = {
        // Default POC key (secp256k1 generator x-coord)
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".to_string()
    };

    let state = Arc::new(AppState {
        tracker: Arc::new(RwLock::new(tracker_with_ws)),
        ws_state,
        group_pubkey,
        bitcoin_network: "testnet".to_string(),
    });

    let cors = crate::common::cors::cors_from_env();

    let authed = Router::new()
        .route("/api/deposits", post(handle_register_deposit))
        .route("/api/tracker/retry/{id}", post(handle_retry_deposit))
        .layer(axum::middleware::from_fn(api_key_auth_middleware))
        .with_state(state.clone());

    let public = Router::new()
        .route("/api/deposits", get(handle_list_deposits))
        .route("/api/deposits/verified", get(handle_verified_deposits))
        .route("/api/deposits/{id}", get(handle_get_deposit))
        .route("/api/deposits/by-address/{address}", get(handle_get_by_address))
        .route("/ws/deposits/{id}", get(ws_deposit_handler_wrapper))
        .route("/ws/deposits", get(ws_all_deposits_handler_wrapper))
        .route("/api/pool/info", get(handle_pool_info))
        .route("/api/tracker/health", get(handle_health))
        .route("/api/tracker/stats", get(handle_tracker_stats))
        .route("/api/tracker/pending", get(handle_pending_deposits))
        .route("/api/tracker/failed", get(handle_failed_deposits))
        .with_state(state);

    Router::new()
        .merge(authed)
        .merge(public)
        .layer(axum::middleware::from_fn_with_state(
            create_rate_limiter(),
            rate_limit_middleware,
        ))
        .layer(cors)
}

// =============================================================================
// REST Handlers
// =============================================================================

/// GET /api/deposits/{id}
///
/// Get the status of a specific deposit.
async fn handle_get_deposit(
    State(state): State<SharedAppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tracker = state.tracker.read().await;

    match tracker.get_deposit(&id) {
        Some(record) => {
            let response = DepositStatusResponse::from(&record);
            (StatusCode::OK, Json(response)).into_response()
        }
        None => {
            let error = serde_json::json!({
                "error": "Not found",
                "details": format!("Deposit {} not found", id)
            });
            (StatusCode::NOT_FOUND, Json(error)).into_response()
        }
    }
}

/// GET /api/deposits/verified
///
/// List only verified deposits (status=ready or claimed) with npk/ephemeral_pub.
/// Used by frontend to match deposits to user's viewing key.
async fn handle_verified_deposits(State(state): State<SharedAppState>) -> impl IntoResponse {
    let tracker = state.tracker.read().await;

    let mut verified: Vec<DepositStatusResponse> = Vec::new();
    for record in tracker.get_all_deposits() {
        if matches!(record.status, super::types::DepositStatus::Ready | super::types::DepositStatus::Claimed) {
            verified.push(DepositStatusResponse::from(&record));
        }
    }

    Json(serde_json::json!({
        "deposits": verified
    }))
}

/// GET /api/deposits
///
/// List all deposits (auto-detected via block scanning).
async fn handle_list_deposits(State(state): State<SharedAppState>) -> impl IntoResponse {
    let tracker = state.tracker.read().await;

    let deposits: Vec<DepositStatusResponse> = tracker
        .get_all_deposits()
        .iter()
        .map(DepositStatusResponse::from)
        .collect();

    Json(serde_json::json!({
        "deposits": deposits,
        "stats": tracker.stats()
    }))
}

/// POST /api/deposits
///
/// Register a deposit for tracking. If the address already exists, returns the existing record.
async fn handle_register_deposit(
    State(state): State<SharedAppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let taproot_address = body.get("taproot_address").and_then(|v| v.as_str());
    let commitment = body.get("commitment").and_then(|v| v.as_str());
    let amount_sats = body.get("amount_sats").and_then(|v| v.as_u64());
    let ephemeral_pub = body.get("ephemeral_pub").and_then(|v| v.as_str()).map(String::from);

    let (taproot_address, commitment, amount_sats) = match (taproot_address, commitment, amount_sats) {
        (Some(a), Some(c), Some(amt)) => (a.to_string(), c.to_string(), amt),
        _ => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": "Missing required fields: taproot_address, commitment, amount_sats"
            }))).into_response();
        }
    };

    let tracker = state.tracker.read().await;

    match tracker.register_deposit(taproot_address, commitment, amount_sats, ephemeral_pub) {
        Ok(record) => {
            let response = DepositStatusResponse::from(&record);
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "deposit_id": record.id,
                "deposit": response
            }))).into_response()
        }
        Err(e) => {
            (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": e.to_string()
            }))).into_response()
        }
    }
}

/// GET /api/deposits/by-address/{address}
///
/// Look up a deposit by its taproot address.
async fn handle_get_by_address(
    State(state): State<SharedAppState>,
    Path(address): Path<String>,
) -> impl IntoResponse {
    let tracker = state.tracker.read().await;

    match tracker.get_deposit_by_address(&address) {
        Some(record) => {
            let response = DepositStatusResponse::from(&record);
            (StatusCode::OK, Json(response)).into_response()
        }
        None => {
            let error = serde_json::json!({
                "error": "Not found",
                "details": format!("No deposit found for address {}", address)
            });
            (StatusCode::NOT_FOUND, Json(error)).into_response()
        }
    }
}

/// GET /api/pool/info
///
/// Returns pool configuration needed by SDK for non-interactive deposits.
/// The SDK uses this to derive deposit addresses client-side.
async fn handle_pool_info(State(state): State<SharedAppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "group_pubkey": state.group_pubkey,
        "network": state.bitcoin_network,
        "timelock_blocks": 1,
    }))
}

/// GET /api/tracker/health
///
/// Health check endpoint.
async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "zkbtc-deposit-tracker",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

/// GET /api/tracker/stats
///
/// Get tracker statistics including deposit counts by status.
async fn handle_tracker_stats(State(state): State<SharedAppState>) -> impl IntoResponse {
    let tracker = state.tracker.read().await;
    let stats = tracker.stats();

    Json(serde_json::json!({
        "total_deposits": stats.total_deposits,
        "pending": stats.pending,
        "confirming": stats.confirming,
        "ready": stats.ready,
        "claimed": stats.claimed,
        "failed": stats.failed,
        "total_sats_received": stats.total_sats_received
    }))
}

/// GET /api/tracker/pending
///
/// List all pending deposits (waiting for BTC).
async fn handle_pending_deposits(State(state): State<SharedAppState>) -> impl IntoResponse {
    let tracker = state.tracker.read().await;
    let pending = tracker.get_pending_deposits();

    let deposits: Vec<DepositStatusResponse> = pending
        .iter()
        .map(DepositStatusResponse::from)
        .collect();

    Json(serde_json::json!({
        "count": deposits.len(),
        "deposits": deposits
    }))
}

/// GET /api/tracker/failed
///
/// List all failed deposits with error messages.
async fn handle_failed_deposits(State(state): State<SharedAppState>) -> impl IntoResponse {
    let tracker = state.tracker.read().await;
    let failed = tracker.get_failed_deposits();

    let deposits: Vec<serde_json::Value> = failed
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "taproot_address": r.taproot_address,
                "amount_sats": r.amount_sats,
                "error": r.error,
                "retry_count": r.retry_count,
                "last_retry_at": r.last_retry_at,
                "can_retry": r.can_retry(5), // Default max retries
                "created_at": r.created_at,
                "updated_at": r.updated_at
            })
        })
        .collect();

    Json(serde_json::json!({
        "count": deposits.len(),
        "deposits": deposits
    }))
}

/// POST /api/tracker/retry/{id}
///
/// Manually retry a failed deposit.
async fn handle_retry_deposit(
    State(state): State<SharedAppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let tracker = state.tracker.read().await;

    match tracker.retry_deposit(&id) {
        Ok(()) => {
            (StatusCode::OK, Json(serde_json::json!({
                "success": true,
                "message": format!("Retry initiated for deposit {}", id)
            }))).into_response()
        }
        Err(e) => {
            (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": e.to_string()
            }))).into_response()
        }
    }
}

// =============================================================================
// WebSocket Handler Wrappers
// =============================================================================

/// WebSocket handler wrapper for single deposit
async fn ws_deposit_handler_wrapper(
    ws: axum::extract::ws::WebSocketUpgrade,
    Path(id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    ws_deposit_handler(ws, Path(id), State(state.ws_state.clone())).await
}

/// WebSocket handler wrapper for all deposits
async fn ws_all_deposits_handler_wrapper(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    ws_all_deposits_handler(ws, State(state.ws_state.clone())).await
}

// =============================================================================
// Combined API Server
// =============================================================================

/// Start the deposit tracker API server
///
/// This can be used standalone or combined with the redemption API.
pub async fn start_tracker_server(
    tracker: DepositTrackerService,
    port: u16,
) -> Result<(), std::io::Error> {
    let app = create_deposit_router(tracker);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    println!("=== zkBTC Deposit Tracker API ===");
    println!("Listening on http://{}", addr);
    println!();
    println!("Deposit Endpoints:");
    println!("  POST /api/deposits                   - Register deposit for tracking");
    println!("  GET  /api/deposits                   - List all deposits");
    println!("  GET  /api/deposits/verified           - List verified deposits (ready/claimed)");
    println!("  GET  /api/deposits/{{id}}               - Get deposit status by ID");
    println!("  GET  /api/deposits/by-address/{{addr}}  - Get deposit by taproot address");
    println!("  WS   /ws/deposits/{{id}}                - Subscribe to deposit updates");
    println!("  WS   /ws/deposits                    - Subscribe to all updates");
    println!();
    println!("Pool Info:");
    println!("  GET  /api/pool/info          - Pool config for SDK deposits");
    println!();
    println!("Monitoring Endpoints:");
    println!("  GET  /api/tracker/health    - Health check");
    println!("  GET  /api/tracker/stats     - Get tracker statistics");
    println!("  GET  /api/tracker/pending   - List pending deposits");
    println!("  GET  /api/tracker/failed    - List failed deposits");
    println!("  POST /api/tracker/retry/{{id}} - Retry a failed deposit");
    println!();

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::TrackerConfig;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    fn test_config() -> TrackerConfig {
        TrackerConfig {
            db_path: ":memory:".to_string(),
            ..TrackerConfig::default()
        }
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let tracker = DepositTrackerService::new_testnet(test_config());
        let app = create_deposit_router(tracker);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/tracker/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_get_nonexistent_deposit() {
        let tracker = DepositTrackerService::new_testnet(test_config());
        let app = create_deposit_router(tracker);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/deposits/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
