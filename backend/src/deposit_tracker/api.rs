//! Deposit Tracker API Endpoints
//!
//! REST and WebSocket endpoints for deposit tracking:
//! - POST /api/deposits - Register a new deposit
//! - GET /api/deposits/:id - Get deposit status
//! - WS /ws/deposits/:id - Subscribe to status updates
//! - WS /ws/deposits - Subscribe to all updates
//!
//! V2 Stealth Deposit Endpoints:
//! - POST /api/v2/prepare-deposit - Prepare stealth deposit address
//! - GET /api/v2/deposits/:id - Get stealth deposit status
//! - GET /api/v2/deposits - List all stealth deposits
//! - WS /ws/v2/deposits/:id - Subscribe to stealth deposit updates

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use super::db::StealthDepositStore;
use super::service::DepositTrackerService;
use super::types::{
    DepositStatusResponse, PrepareStealthDepositRequest, PrepareStealthDepositResponse,
    RegisterDepositRequest, RegisterDepositResponse, StealthDepositRecord,
    StealthDepositStatusResponse,
};
use super::websocket::{
    create_ws_state, ws_all_deposits_handler, ws_deposit_handler, SharedWebSocketState,
};

/// Combined application state
pub struct AppState {
    pub tracker: Arc<RwLock<DepositTrackerService>>,
    pub ws_state: SharedWebSocketState,
    /// Stealth deposit v2 store
    pub stealth_store: StealthDepositStore,
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
        stealth_store: StealthDepositStore::new(),
        group_pubkey,
        bitcoin_network: "testnet".to_string(),
    });

    // CORS configuration
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Regular deposit endpoints
        .route("/api/deposits", post(handle_register_deposit))
        .route("/api/deposits/:id", get(handle_get_deposit))
        .route("/api/deposits", get(handle_list_deposits))
        // Stealth deposit endpoints
        .route("/api/stealth/prepare", post(handle_prepare_stealth_deposit))
        .route("/api/stealth/:id", get(handle_get_stealth_deposit))
        .route("/api/stealth", get(handle_list_stealth_deposits))
        // WebSocket endpoints
        .route("/ws/deposits/:id", get(ws_deposit_handler_wrapper))
        .route("/ws/deposits", get(ws_all_deposits_handler_wrapper))
        .route("/ws/stealth/:id", get(ws_stealth_deposit_handler))
        // Pool info (for SDK non-interactive deposits)
        .route("/api/pool/info", get(handle_pool_info))
        // Health check and monitoring
        .route("/api/tracker/health", get(handle_health))
        .route("/api/tracker/stats", get(handle_tracker_stats))
        .route("/api/tracker/pending", get(handle_pending_deposits))
        .route("/api/tracker/failed", get(handle_failed_deposits))
        .route("/api/tracker/retry/:id", post(handle_retry_deposit))
        .layer(cors)
        .with_state(state)
}

// =============================================================================
// REST Handlers
// =============================================================================

/// POST /api/deposits
///
/// Register a new deposit to track.
async fn handle_register_deposit(
    State(state): State<SharedAppState>,
    Json(req): Json<RegisterDepositRequest>,
) -> impl IntoResponse {
    let tracker = state.tracker.write().await;

    match tracker.register_deposit(req.taproot_address, req.commitment, req.amount_sats) {
        Ok(id) => {
            let response = RegisterDepositResponse {
                success: true,
                deposit_id: Some(id),
                message: Some("Deposit registered for tracking".to_string()),
            };
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            let response = RegisterDepositResponse {
                success: false,
                deposit_id: None,
                message: Some(e.to_string()),
            };
            (StatusCode::BAD_REQUEST, Json(response))
        }
    }
}

/// GET /api/deposits/:id
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

/// GET /api/deposits
///
/// List all deposits (for admin/debugging).
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

/// GET /api/pool/info
///
/// Returns pool configuration needed by SDK for non-interactive deposits.
/// The SDK uses this to derive deposit addresses client-side without
/// calling POST /api/stealth/prepare.
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

/// POST /api/tracker/retry/:id
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
// V2 Stealth Deposit Handlers
// =============================================================================

fn is_valid_pubkey_hex(s: &str) -> bool {
    s.len() == 66 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn stealth_error_response(error: &str) -> (StatusCode, Json<PrepareStealthDepositResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(PrepareStealthDepositResponse {
            success: false,
            deposit_id: None,
            btc_address: None,
            ephemeral_pub: None,
            expires_at: None,
            error: Some(error.to_string()),
        }),
    )
}

/// POST /api/v2/prepare-deposit
///
/// Prepare a stealth deposit address with ephemeral key.
async fn handle_prepare_stealth_deposit(
    State(state): State<SharedAppState>,
    Json(req): Json<PrepareStealthDepositRequest>,
) -> impl IntoResponse {
    if !is_valid_pubkey_hex(&req.viewing_pub) {
        return stealth_error_response("Invalid viewing public key format (expected 66 hex chars)");
    }

    if !is_valid_pubkey_hex(&req.spending_pub) {
        return stealth_error_response("Invalid spending public key format (expected 66 hex chars)");
    }

    if !is_valid_pubkey_hex(&req.ephemeral_pub) {
        return stealth_error_response("Invalid ephemeral public key format (expected 66 hex chars)");
    }

    // Validate npk (64 hex chars = 32 bytes)
    if req.npk.len() != 64 || !req.npk.chars().all(|c| c.is_ascii_hexdigit()) {
        return stealth_error_response("Invalid npk format (expected 64 hex chars)");
    }

    // Parse npk bytes for address derivation
    let npk_bytes = match hex::decode(&req.npk) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            arr
        }
        _ => return stealth_error_response("Invalid npk: must be 32 bytes hex"),
    };

    // Derive BTC Taproot address from pool keys + npk
    let pool_keys = crate::taproot::PoolKeys::new();
    let network = bitcoin::Network::Testnet; // TODO: derive from config
    let btc_address = match crate::taproot::generate_deposit_address(&pool_keys, &npk_bytes, network) {
        Ok(deposit) => deposit.address,
        Err(e) => return stealth_error_response(&format!("Failed to derive BTC address: {}", e)),
    };

    let ephemeral_pub = req.ephemeral_pub.clone();
    let commitment = req.npk.clone(); // npk used as commitment identifier

    // Create record (ephemeral private key is held client-side in stealth flow)
    let record = StealthDepositRecord::new(
        req.viewing_pub,
        req.spending_pub,
        ephemeral_pub.clone(),
        String::new(), // ephemeral private key stays client-side
        commitment,
        btc_address.clone(),
    );

    let deposit_id = record.id.clone();
    let expires_at = record.expires_at;

    // Store record
    match state.stealth_store.insert(record).await {
        Ok(_) => (
            StatusCode::OK,
            Json(PrepareStealthDepositResponse {
                success: true,
                deposit_id: Some(deposit_id),
                btc_address: Some(btc_address),
                ephemeral_pub: Some(ephemeral_pub),
                expires_at: Some(expires_at),
                error: None,
            }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(PrepareStealthDepositResponse {
                success: false,
                deposit_id: None,
                btc_address: None,
                ephemeral_pub: None,
                expires_at: None,
                error: Some(e.to_string()),
            }),
        ),
    }
}

/// GET /api/v2/deposits/:id
///
/// Get stealth deposit status by ID.
async fn handle_get_stealth_deposit(
    State(state): State<SharedAppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.stealth_store.get(&id).await {
        Some(record) => {
            let response = StealthDepositStatusResponse::from(&record);
            (StatusCode::OK, Json(response)).into_response()
        }
        None => {
            let error = serde_json::json!({
                "error": "Not found",
                "details": format!("Stealth deposit {} not found", id)
            });
            (StatusCode::NOT_FOUND, Json(error)).into_response()
        }
    }
}

/// GET /api/v2/deposits
///
/// List all stealth deposits (for admin/debugging).
async fn handle_list_stealth_deposits(State(state): State<SharedAppState>) -> impl IntoResponse {
    let deposits: Vec<StealthDepositStatusResponse> = state
        .stealth_store
        .get_all()
        .await
        .iter()
        .map(StealthDepositStatusResponse::from)
        .collect();

    let stats = state.stealth_store.stats().await;

    Json(serde_json::json!({
        "deposits": deposits,
        "stats": stats
    }))
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

/// WebSocket handler for stealth deposit v2 updates
async fn ws_stealth_deposit_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    Path(id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    use axum::extract::ws::Message;
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;

    ws.on_upgrade(move |socket| async move {
        let (mut sender, mut receiver) = socket.split();

        // Send initial status
        if let Some(record) = state.stealth_store.get(&id).await {
            let update = super::types::StealthDepositStatusUpdate::from(&record);
            if let Ok(json) = serde_json::to_string(&update) {
                let _ = sender.send(Message::Text(json)).await;
            }
        }

        // Poll for updates every 2 seconds
        let poll_state = state.clone();
        let poll_id = id.clone();
        let poll_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            let mut last_status = String::new();

            loop {
                interval.tick().await;

                if let Some(record) = poll_state.stealth_store.get(&poll_id).await {
                    let current_status = record.status.to_string();
                    if current_status != last_status {
                        last_status = current_status;
                        let update = super::types::StealthDepositStatusUpdate::from(&record);
                        if let Ok(json) = serde_json::to_string(&update) {
                            // Send through channel (simplified - in production use proper channel)
                            println!("[WS] Status update for {}: {}", poll_id, json);
                        }
                    }

                    // Stop polling if terminal state
                    if record.is_ready() || record.status == super::types::StealthDepositStatus::Failed {
                        break;
                    }
                }
            }
        });

        // Handle incoming messages (for keepalive/close)
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(data)) => {
                    let _ = sender.send(Message::Pong(data)).await;
                }
                _ => {}
            }
        }

        poll_task.abort();
    })
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
    println!("  POST /api/deposits          - Register deposit to track");
    println!("  GET  /api/deposits/:id      - Get deposit status");
    println!("  GET  /api/deposits          - List all deposits");
    println!("  WS   /ws/deposits/:id       - Subscribe to deposit updates");
    println!("  WS   /ws/deposits           - Subscribe to all updates");
    println!();
    println!("Pool Info:");
    println!("  GET  /api/pool/info          - Pool config for SDK deposits");
    println!();
    println!("Stealth Deposit Endpoints:");
    println!("  POST /api/stealth/prepare   - Prepare stealth deposit");
    println!("  GET  /api/stealth/:id       - Get stealth deposit status");
    println!("  GET  /api/stealth           - List stealth deposits");
    println!("  WS   /ws/stealth/:id        - Subscribe to stealth updates");
    println!();
    println!("Monitoring Endpoints:");
    println!("  GET  /api/tracker/health    - Health check");
    println!("  GET  /api/tracker/stats     - Get tracker statistics");
    println!("  GET  /api/tracker/pending   - List pending deposits");
    println!("  GET  /api/tracker/failed    - List failed deposits");
    println!("  POST /api/tracker/retry/:id - Retry a failed deposit");
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
    async fn test_register_deposit() {
        let tracker = DepositTrackerService::new_testnet(test_config());
        let app = create_deposit_router(tracker);

        let body = serde_json::json!({
            "taproot_address": "tb1p123abc",
            "commitment": "a".repeat(64),
            "amount_sats": 100000
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/deposits")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
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
