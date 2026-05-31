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
use serde_json::Value;
use std::process::Command;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegtestFaucetRequest {
    pub address: String,
    pub amount_sats: u64,
    #[serde(default)]
    pub op_return: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegtestFaucetResponse {
    pub ok: bool,
    pub txid: Option<String>,
    pub blocks_mined: u64,
    pub deposit_address: String,
    pub op_return: Option<String>,
    pub amount_sats: u64,
    pub warning: Option<String>,
    pub error: Option<String>,
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

fn faucet_env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn faucet_bcli_args() -> Vec<String> {
    faucet_env("REGTEST_FAUCET_BCLI_ARGS", "-regtest -datadir=/data/bitcoin -rpcwallet=test")
        .split_whitespace()
        .map(ToString::to_string)
        .collect()
}

fn is_valid_regtest_address(addr: &str) -> bool {
    addr.starts_with("bcrt1")
        && addr.len() >= 42
        && addr.len() <= 94
        && addr.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn is_valid_op_return_hex(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.len() % 2 == 0
        && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn sats_to_btc_decimal(sats: u64) -> String {
    format!("{}.{:08}", sats / 100_000_000, sats % 100_000_000)
}

fn run_bitcoin_cli(args: &[&str]) -> Result<String, String> {
    let docker = faucet_env("REGTEST_FAUCET_DOCKER_BIN", "docker");
    let container = faucet_env("REGTEST_FAUCET_DOCKER_CONTAINER", "utxopia-esplora-regtest");
    let bcli = faucet_env("REGTEST_FAUCET_BITCOIN_CLI", "/srv/explorer/bitcoin/bin/bitcoin-cli");
    let bcli_args = faucet_bcli_args();

    let output = Command::new(&docker)
        .arg("exec")
        .arg(container)
        .arg(bcli)
        .args(bcli_args)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run docker/bitcoin-cli: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn ensure_regtest_wallet_funded() -> Result<(), String> {
    let balance = run_bitcoin_cli(&["getbalance"])
        .map_err(|e| format!("getbalance failed: {e}"))?;
    if balance.parse::<f64>().unwrap_or(0.0) > 0.0 {
        return Ok(());
    }

    if std::env::var("REGTEST_FAUCET_AUTOMINE").unwrap_or_else(|_| "1".to_string()) == "0" {
        return Err("wallet has zero spendable balance and REGTEST_FAUCET_AUTOMINE=0".to_string());
    }

    let miner = run_bitcoin_cli(&["getnewaddress"])
        .map_err(|e| format!("getnewaddress failed during bootstrap: {e}"))?;
    run_bitcoin_cli(&["generatetoaddress", "101", &miner])
        .map_err(|e| format!("bootstrap mining failed: {e}"))?;
    Ok(())
}

async fn handle_regtest_faucet(Json(req): Json<RegtestFaucetRequest>) -> impl IntoResponse {
    let max_sats = std::env::var("REGTEST_FAUCET_MAX_SATS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(100_000);
    let confirmations = std::env::var("REGTEST_FAUCET_CONFIRMATIONS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(6)
        .max(1);

    if std::env::var("UTXOPIA_BITCOIN_NETWORK").unwrap_or_default() != "regtest" {
        return (
            StatusCode::BAD_REQUEST,
            Json(RegtestFaucetResponse {
                ok: false,
                txid: None,
                blocks_mined: 0,
                deposit_address: req.address,
                op_return: req.op_return,
                amount_sats: req.amount_sats,
                warning: None,
                error: Some("faucet only available when backend UTXOPIA_BITCOIN_NETWORK=regtest".to_string()),
            }),
        );
    }

    if !is_valid_regtest_address(&req.address) {
        return (
            StatusCode::BAD_REQUEST,
            Json(RegtestFaucetResponse {
                ok: false,
                txid: None,
                blocks_mined: 0,
                deposit_address: req.address,
                op_return: req.op_return,
                amount_sats: req.amount_sats,
                warning: None,
                error: Some("address must be a regtest bech32 address".to_string()),
            }),
        );
    }
    if req.amount_sats == 0 || req.amount_sats > max_sats {
        return (
            StatusCode::BAD_REQUEST,
            Json(RegtestFaucetResponse {
                ok: false,
                txid: None,
                blocks_mined: 0,
                deposit_address: req.address,
                op_return: req.op_return,
                amount_sats: req.amount_sats,
                warning: None,
                error: Some(format!("amountSats must be an integer from 1..{max_sats}")),
            }),
        );
    }
    if let Some(ref op_return) = req.op_return {
        if !is_valid_op_return_hex(op_return) {
            return (
                StatusCode::BAD_REQUEST,
                Json(RegtestFaucetResponse {
                    ok: false,
                    txid: None,
                    blocks_mined: 0,
                    deposit_address: req.address,
                    op_return: req.op_return,
                    amount_sats: req.amount_sats,
                    warning: None,
                    error: Some("opReturn must be hex and at most 80 bytes".to_string()),
                }),
            );
        }
    }

    if let Err(e) = ensure_regtest_wallet_funded() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(RegtestFaucetResponse {
                ok: false,
                txid: None,
                blocks_mined: 0,
                deposit_address: req.address,
                op_return: req.op_return,
                amount_sats: req.amount_sats,
                warning: None,
                error: Some(e),
            }),
        );
    }

    let amount_btc = sats_to_btc_decimal(req.amount_sats);
    let txid = if let Some(ref op_return) = req.op_return {
        let outputs = serde_json::json!([
            { req.address.clone(): amount_btc.parse::<f64>().unwrap_or(0.0) },
            { "data": op_return },
        ]);
        let outputs = outputs.to_string();
        let raw = match run_bitcoin_cli(&["createrawtransaction", "[]", &outputs]) {
            Ok(v) => v,
            Err(e) => return faucet_error(StatusCode::BAD_GATEWAY, req, format!("createrawtransaction failed: {e}")),
        };
        let funded = match run_bitcoin_cli(&["fundrawtransaction", &raw]) {
            Ok(v) => v,
            Err(e) => return faucet_error(StatusCode::BAD_GATEWAY, req, format!("fundrawtransaction failed: {e}")),
        };
        let funded_hex = match serde_json::from_str::<Value>(&funded)
            .ok()
            .and_then(|v| v.get("hex").and_then(|h| h.as_str()).map(ToString::to_string))
        {
            Some(v) => v,
            None => return faucet_error(StatusCode::BAD_GATEWAY, req, "fundrawtransaction returned no hex".to_string()),
        };
        let signed = match run_bitcoin_cli(&["signrawtransactionwithwallet", &funded_hex]) {
            Ok(v) => v,
            Err(e) => return faucet_error(StatusCode::BAD_GATEWAY, req, format!("signrawtransactionwithwallet failed: {e}")),
        };
        let signed_json = match serde_json::from_str::<Value>(&signed) {
            Ok(v) => v,
            Err(e) => return faucet_error(StatusCode::BAD_GATEWAY, req, format!("invalid sign result: {e}")),
        };
        if !signed_json.get("complete").and_then(|v| v.as_bool()).unwrap_or(false) {
            return faucet_error(StatusCode::BAD_GATEWAY, req, "signrawtransactionwithwallet did not complete".to_string());
        }
        let signed_hex = match signed_json.get("hex").and_then(|h| h.as_str()) {
            Some(v) => v,
            None => return faucet_error(StatusCode::BAD_GATEWAY, req, "signrawtransactionwithwallet returned no hex".to_string()),
        };
        match run_bitcoin_cli(&["sendrawtransaction", signed_hex]) {
            Ok(v) => v,
            Err(e) => return faucet_error(StatusCode::BAD_GATEWAY, req, format!("sendrawtransaction failed: {e}")),
        }
    } else {
        match run_bitcoin_cli(&["sendtoaddress", &req.address, &amount_btc]) {
            Ok(v) => v,
            Err(e) => return faucet_error(StatusCode::BAD_GATEWAY, req, format!("sendtoaddress failed: {e}")),
        }
    };

    let miner = match run_bitcoin_cli(&["getnewaddress"]) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::OK,
                Json(RegtestFaucetResponse {
                    ok: true,
                    txid: Some(txid),
                    blocks_mined: 0,
                    deposit_address: req.address,
                    op_return: req.op_return,
                    amount_sats: req.amount_sats,
                    warning: Some(format!("deposit broadcast but mining failed at getnewaddress: {e}")),
                    error: None,
                }),
            )
        }
    };
    if let Err(e) = run_bitcoin_cli(&["generatetoaddress", &confirmations.to_string(), &miner]) {
        return (
            StatusCode::OK,
            Json(RegtestFaucetResponse {
                ok: true,
                txid: Some(txid),
                blocks_mined: 0,
                deposit_address: req.address,
                op_return: req.op_return,
                amount_sats: req.amount_sats,
                warning: Some(format!("deposit broadcast but mining failed: {e}")),
                error: None,
            }),
        );
    }

    (
        StatusCode::OK,
        Json(RegtestFaucetResponse {
            ok: true,
            txid: Some(txid),
            blocks_mined: confirmations,
            deposit_address: req.address,
            op_return: req.op_return,
            amount_sats: req.amount_sats,
            warning: None,
            error: None,
        }),
    )
}

fn faucet_error(status: StatusCode, req: RegtestFaucetRequest, error: String) -> (StatusCode, Json<RegtestFaucetResponse>) {
    (
        status,
        Json(RegtestFaucetResponse {
            ok: false,
            txid: None,
            blocks_mined: 0,
            deposit_address: req.address,
            op_return: req.op_return,
            amount_sats: req.amount_sats,
            warning: None,
            error: Some(error),
        }),
    )
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
        .route("/api/faucet/regtest", post(handle_regtest_faucet))
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
