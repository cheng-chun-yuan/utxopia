//! REST API for Redemption Service
//!
//! Minimal API with 2 endpoints:
//! - POST /api/redeem - Submit withdrawal request
//! - GET /api/withdrawal/:id - Check withdrawal status
//!
//! All other operations (deposit, claim, split) are handled client-side via SDK.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::common::cors::cors_from_env;

use crate::api::middleware::{api_key_auth_middleware, create_rate_limiter, rate_limit_middleware, security_headers_middleware};
use crate::redemption::{RedemptionService, WithdrawalStatus};
use crate::stealth::{
    ManualAnnounceRequest, ManualAnnounceResponse, PrepareStealthRelayResponse,
    PrepareStealthSelfCustodyResponse, PrepareStealthRequest,
    StealthDepositService, StealthMode, StealthStatusResponse,
};

// =============================================================================
// Request/Response Types
// =============================================================================

#[derive(Debug, Deserialize)]
pub struct RedeemRequest {
    pub amount_sats: u64,
    pub btc_address: String,
    pub solana_address: String,
    /// On-chain redemption nonce (from RedemptionRequest PDA) for FROST Solana verification
    #[serde(default)]
    pub redemption_nonce: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct RedeemResponse {
    pub success: bool,
    pub request_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WithdrawalStatusResponse {
    pub request_id: String,
    pub status: String,
    pub amount_sats: u64,
    pub btc_address: String,
    pub btc_txid: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub details: Option<String>,
}

pub struct CombinedAppState {
    pub redemption: Arc<RwLock<RedemptionService>>,
    pub stealth: Arc<RwLock<StealthDepositService>>,
}

pub type SharedCombinedState = Arc<CombinedAppState>;

pub type AppState = Arc<RwLock<RedemptionService>>;

// =============================================================================
// API Handlers
// =============================================================================

/// POST /api/redeem
///
/// Submit a withdrawal request. The redemption processor will:
/// 1. Validate the request
/// 2. Build and sign a BTC transaction
/// 3. Broadcast to the Bitcoin network
///
/// Returns a request_id to track status.
async fn handle_redeem(
    State(service): State<AppState>,
    Json(req): Json<RedeemRequest>,
) -> impl IntoResponse {
    use crate::api::middleware::{validate_btc_address, validate_solana_address, validate_amount_sats};

    let start = std::time::Instant::now();

    // Validate inputs
    let btc_val = validate_btc_address(&req.btc_address);
    let sol_val = validate_solana_address(&req.solana_address);
    let amt_val = validate_amount_sats(req.amount_sats, 546, 2_100_000_000_000_000);
    if !btc_val.is_valid || !sol_val.is_valid || !amt_val.is_valid {
        let mut errors = btc_val.errors;
        errors.extend(sol_val.errors);
        errors.extend(amt_val.errors);
        let response = RedeemResponse {
            success: false,
            request_id: None,
            message: Some(errors.join("; ")),
        };
        tracing::info!(
            operation = "api_redeem",
            status = "validation_failed",
            duration_ms = start.elapsed().as_millis() as u64,
            "redeem request rejected"
        );
        return (StatusCode::BAD_REQUEST, Json(response));
    }

    let service = service.read().await;

    match service
        .submit_withdrawal(
            format!("api_request_{}", chrono::Utc::now().timestamp_millis()),
            req.solana_address.clone(),
            req.amount_sats,
            req.btc_address.clone(),
            req.redemption_nonce,
        )
        .await
    {
        Ok(request_id) => {
            tracing::info!(
                operation = "api_redeem",
                status = "success",
                amount_sats = req.amount_sats,
                duration_ms = start.elapsed().as_millis() as u64,
                "redeem request accepted"
            );
            let response = RedeemResponse {
                success: true,
                request_id: Some(request_id),
                message: Some("Withdrawal request submitted".to_string()),
            };
            (StatusCode::OK, Json(response))
        }
        Err(e) => {
            tracing::warn!(
                operation = "api_redeem",
                status = "failed",
                error = %e,
                amount_sats = req.amount_sats,
                duration_ms = start.elapsed().as_millis() as u64,
                "redeem request failed"
            );
            let response = RedeemResponse {
                success: false,
                request_id: None,
                message: Some("Withdrawal request failed".to_string()),
            };
            (StatusCode::BAD_REQUEST, Json(response))
        }
    }
}

/// GET /api/withdrawal/:id
///
/// Check the status of a withdrawal request.
async fn handle_withdrawal_status(
    State(service): State<AppState>,
    Path(request_id): Path<String>,
) -> impl IntoResponse {
    let service = service.read().await;

    match service.get_request(&request_id).await {
        Some(request) => {
            let status_str = match request.status {
                WithdrawalStatus::Pending => "pending",
                WithdrawalStatus::Building => "processing",
                WithdrawalStatus::Signing => "processing",
                WithdrawalStatus::Broadcasting => "broadcasting",
                WithdrawalStatus::Confirming => "broadcasting",
                WithdrawalStatus::Complete => "completed",
                WithdrawalStatus::Failed => "failed",
            };

            let response = WithdrawalStatusResponse {
                request_id: request.id,
                status: status_str.to_string(),
                amount_sats: request.amount_sats,
                btc_address: request.btc_address,
                btc_txid: request.btc_txid,
                created_at: request.created_at,
                updated_at: request.updated_at,
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        None => {
            let response = ErrorResponse {
                error: "Not found".to_string(),
                details: Some(format!("Withdrawal request {} not found", request_id)),
            };
            (StatusCode::NOT_FOUND, Json(response)).into_response()
        }
    }
}

/// GET /api/health
///
/// Health check endpoint.
async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "zkbtc-api",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

async fn handle_stealth_prepare(
    State(state): State<SharedCombinedState>,
    Json(req): Json<PrepareStealthRequest>,
) -> impl IntoResponse {
    let mut service = state.stealth.write().await;

    match service.prepare_deposit(req.recipient_stealth_address, req.amount_sats, req.mode) {
        Ok(record) => match req.mode {
            StealthMode::Relay => {
                let response = PrepareStealthRelayResponse {
                    success: true,
                    deposit_id: Some(record.id),
                    taproot_address: Some(record.taproot_address),
                    amount_sats: record.amount_sats,
                    expires_at: Some(record.expires_at),
                    message: None,
                };
                (StatusCode::OK, Json(serde_json::json!(response))).into_response()
            }
            StealthMode::SelfCustody => {
                let stealth_data = service.create_stealth_data(&record);
                let response = PrepareStealthSelfCustodyResponse {
                    success: true,
                    taproot_address: Some(record.taproot_address),
                    amount_sats: record.amount_sats,
                    stealth_data: Some(stealth_data.encode()),
                    message: None,
                };
                (StatusCode::OK, Json(serde_json::json!(response))).into_response()
            }
        },
        Err(e) => {
            let response = PrepareStealthRelayResponse {
                success: false,
                deposit_id: None,
                taproot_address: None,
                amount_sats: req.amount_sats,
                expires_at: None,
                message: Some(e.to_string()),
            };
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!(response)),
            )
                .into_response()
        }
    }
}

async fn handle_stealth_status(
    State(state): State<SharedCombinedState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let service = state.stealth.read().await;

    match service.get_deposit(&id) {
        Some(record) => {
            let response = StealthStatusResponse::from(record);
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

async fn handle_stealth_announce(
    State(_state): State<SharedCombinedState>,
    Json(_req): Json<ManualAnnounceRequest>,
) -> impl IntoResponse {
    let response = ManualAnnounceResponse {
        success: false,
        solana_tx: None,
        leaf_index: None,
        message: Some("Endpoint removed — stealth announcements are emitted as on-chain events via transact flow".to_string()),
    };
    (StatusCode::GONE, Json(response))
}

pub fn create_router(service: RedemptionService) -> Router {
    let state: AppState = Arc::new(RwLock::new(service));
    let rate_limiter = create_rate_limiter();

    let authed = Router::new()
        .route("/api/redeem", post(handle_redeem))
        .route("/api/withdrawal/status/{id}", get(handle_withdrawal_status))
        .layer(axum::middleware::from_fn(api_key_auth_middleware))
        .with_state(state.clone());

    let public = Router::new()
        .route("/api/health", get(handle_health));

    Router::new()
        .merge(authed)
        .merge(public)
        .layer(axum::middleware::from_fn_with_state(
            rate_limiter,
            rate_limit_middleware,
        ))
        .layer(axum::middleware::from_fn(security_headers_middleware))
        .layer(cors_from_env())
}

/// GET /api/relayer/meta — returns relayer config and fee structure
///
/// Two separate fees:
/// - `relayer_fee_sats`: paid to the relayer as a shielded note (for submitting Solana txs
///   on behalf of users during private JoinSplit transfers)
/// - `service_fee_base` + `service_fee_bps`: withdrawal fee = (amount * bps / 10000) + base
async fn handle_relayer_meta(
    State(state): State<SharedCombinedState>,
) -> impl IntoResponse {
    #[derive(Serialize)]
    struct RelayerMetaResponse {
        /// Relayer's stealth meta-address (hex). Users send a fee note to this address.
        stealth_meta: Option<String>,
        /// Flat fee for private sends — paid to relayer as a shielded output note (BTC default)
        relayer_fee_sats: u64,
        /// Per-token relayer fees in native smallest units
        relayer_fees: std::collections::HashMap<String, u64>,
        /// Base service fee for BTC withdrawals (sats)
        service_fee_base: u64,
        /// Service fee in basis points (e.g., 30 = 0.3%)
        service_fee_bps: u16,
        /// Minimum withdrawal amount (sats)
        min_withdrawal: u64,
    }

    use crate::constants::*;

    let relayer_fee_sats: u64 = std::env::var("RELAYER_FEE_SATS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_RELAYER_FEE_BTC);

    // Per-token relayer fees (env override or sensible defaults)
    let parse_env = |key: &str, default: u64| -> u64 {
        std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    let mut relayer_fees = std::collections::HashMap::new();
    relayer_fees.insert("zkBTC".to_string(), relayer_fee_sats);
    relayer_fees.insert("zkSOL".to_string(), parse_env("RELAYER_FEE_SOL", DEFAULT_RELAYER_FEE_SOL));
    relayer_fees.insert("zkUSDC".to_string(), parse_env("RELAYER_FEE_USDC", DEFAULT_RELAYER_FEE_USDC));
    relayer_fees.insert("zkUSDT".to_string(), parse_env("RELAYER_FEE_USDT", DEFAULT_RELAYER_FEE_USDT));
    relayer_fees.insert("zkJupUSD".to_string(), parse_env("RELAYER_FEE_JUPUSD", DEFAULT_RELAYER_FEE_JUPUSD));

    // Read fee + limit config from on-chain PoolState (refreshed each tick)
    let (service_fee_bps, service_fee_base, min_withdrawal) = {
        let svc = state.redemption.read().await;
        let (bps, base) = svc.service_fee_config().await;
        let (min, _max) = svc.withdrawal_limits();
        (bps, base, min)
    };

    let stealth_meta = std::env::var("RELAYER_STEALTH_META").ok();

    Json(RelayerMetaResponse {
        stealth_meta,
        relayer_fee_sats,
        relayer_fees,
        service_fee_base,
        service_fee_bps,
        min_withdrawal,
    })
}

pub fn create_combined_router(
    redemption: RedemptionService,
    stealth: StealthDepositService,
) -> Router {
    let state = Arc::new(CombinedAppState {
        redemption: Arc::new(RwLock::new(redemption)),
        stealth: Arc::new(RwLock::new(stealth)),
    });
    let rate_limiter = create_rate_limiter();

    let authed = Router::new()
        .route("/api/stealth/prepare", post(handle_stealth_prepare))
        .route("/api/stealth/status/{id}", get(handle_stealth_status))
        .route("/api/stealth/announce", post(handle_stealth_announce))
        .layer(axum::middleware::from_fn(api_key_auth_middleware))
        .with_state(state.clone());

    let public = Router::new()
        .route("/api/health", get(handle_health))
        .route("/api/relayer/meta", get(handle_relayer_meta))
        .with_state(state.clone());

    Router::new()
        .merge(authed)
        .merge(public)
        .layer(axum::middleware::from_fn_with_state(
            rate_limiter,
            rate_limit_middleware,
        ))
        .layer(axum::middleware::from_fn(security_headers_middleware))
        .layer(cors_from_env())
}

pub async fn start_server(service: RedemptionService, port: u16) -> Result<(), std::io::Error> {
    let app = create_router(service);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    println!("=== zkBTC Redemption API ===");
    println!("Listening on http://{}", addr);
    println!();
    println!("Endpoints:");
    println!("  POST /api/redeem          - Submit withdrawal request");
    println!("  GET  /api/withdrawal/:id  - Check withdrawal status");
    println!("  GET  /api/health          - Health check");
    println!();

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}

pub async fn start_combined_server(
    redemption: RedemptionService,
    stealth: StealthDepositService,
    port: u16,
) -> Result<(), std::io::Error> {
    let app = create_combined_router(redemption, stealth);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    println!("=== zkBTC Combined API ===");
    println!("Listening on http://{}", addr);
    println!();
    println!("Endpoints:");
    println!("  GET  /api/health              - Health check");
    println!("  POST /api/stealth/prepare     - Prepare stealth deposit");
    println!("  GET  /api/stealth/status/{{id}}  - Get stealth deposit status");
    println!("  POST /api/stealth/announce    - Manual announcement");
    println!();

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test(flavor = "multi_thread")]
    async fn test_health_endpoint() {
        let service = RedemptionService::new_testnet();
        let app = create_router(service);

        let response = app
            .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
