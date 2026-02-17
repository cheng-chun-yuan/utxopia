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

use super::service::{SharedStealthService, StealthDepositService};
use super::types::{
    ManualAnnounceRequest, ManualAnnounceResponse, PrepareStealthRelayResponse,
    PrepareStealthSelfCustodyResponse, PrepareStealthRequest, StealthData, StealthMode,
    StealthStatusResponse,
};

pub type SharedAppState = Arc<AppState>;

pub struct AppState {
    pub stealth: SharedStealthService,
}

pub fn create_stealth_router(service: StealthDepositService) -> Router {
    let state = Arc::new(AppState {
        stealth: Arc::new(RwLock::new(service)),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/stealth/prepare", post(handle_prepare))
        .route("/api/stealth/status/:id", get(handle_status))
        .route("/api/stealth/announce", post(handle_announce))
        .route("/api/stealth/health", get(handle_health))
        .layer(cors)
        .with_state(state)
}

async fn handle_prepare(
    State(state): State<SharedAppState>,
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
                (StatusCode::OK, Json(serde_json::to_value(response).unwrap())).into_response()
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
                (StatusCode::OK, Json(serde_json::to_value(response).unwrap())).into_response()
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
                Json(serde_json::to_value(response).unwrap()),
            )
                .into_response()
        }
    }
}

async fn handle_status(
    State(state): State<SharedAppState>,
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

async fn handle_announce(
    State(_state): State<SharedAppState>,
    Json(req): Json<ManualAnnounceRequest>,
) -> impl IntoResponse {
    let stealth_data = match StealthData::decode(&req.stealth_data) {
        Ok(data) => data,
        Err(e) => {
            let response = ManualAnnounceResponse {
                success: false,
                solana_tx: None,
                leaf_index: None,
                message: Some(format!("Invalid stealth data: {}", e)),
            };
            return (StatusCode::BAD_REQUEST, Json(response));
        }
    };

    // TODO: Implement actual Solana announcement
    // For now, return a placeholder response
    let response = ManualAnnounceResponse {
        success: true,
        solana_tx: Some("simulated_tx_signature".to_string()),
        leaf_index: Some(0),
        message: Some(format!(
            "Announcement simulated for commitment {}",
            &stealth_data.commitment[..16]
        )),
    };

    (StatusCode::OK, Json(response))
}

async fn handle_health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "stealth-deposit-api",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

pub async fn start_stealth_server(
    service: StealthDepositService,
    port: u16,
) -> Result<(), std::io::Error> {
    let app = create_stealth_router(service);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    println!("=== Stealth Deposit API ===");
    println!("Listening on http://{}", addr);
    println!();
    println!("Endpoints:");
    println!("  POST /api/stealth/prepare     - Prepare stealth deposit");
    println!("  GET  /api/stealth/status/:id  - Get deposit status");
    println!("  POST /api/stealth/announce    - Manual announcement");
    println!("  GET  /api/stealth/health      - Health check");
    println!();

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_health_endpoint() {
        let service = StealthDepositService::new_testnet();
        let app = create_stealth_router(service);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/stealth/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_prepare_relay() {
        let service = StealthDepositService::new_testnet();
        let app = create_stealth_router(service);

        let body = serde_json::json!({
            "recipient_stealth_address": "a".repeat(130),
            "amount_sats": 100000,
            "mode": "relay"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/stealth/prepare")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
