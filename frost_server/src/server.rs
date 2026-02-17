//! Axum HTTP server for FROST signer
//!
//! Exposes signing and DKG endpoints for threshold operations.

use crate::dkg::{DkgError, DkgParticipant};
use crate::keystore::Keystore;
use crate::signing::{FrostSigner, SigningError};
use crate::types::{
    AggregateRequest, AggregateResponse, DkgFinalizeRequest, DkgFinalizeResponse,
    DkgRound1Request, DkgRound1Response, DkgRound2Request, DkgRound2Response,
    ErrorResponse, HealthResponse, Round1Request, Round1Response, Round2Request,
    Round2Response, SignerInfo,
};
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

/// Application state shared across handlers
pub struct AppState {
    /// Signer identifier
    pub signer_id: u16,
    /// FROST signer (loaded after DKG or from keystore)
    pub signer: RwLock<Option<FrostSigner>>,
    /// DKG participant
    pub dkg: DkgParticipant,
    /// Key password (for DKG finalization)
    pub key_password: String,
}

impl AppState {
    /// Create new app state
    pub fn new(signer_id: u16, keystore: Keystore, key_password: String) -> Self {
        Self {
            signer_id,
            signer: RwLock::new(None),
            dkg: DkgParticipant::new(signer_id, keystore),
            key_password,
        }
    }

    /// Load existing key share
    pub async fn load_key(&self, keystore: &Keystore) -> Result<(), crate::keystore::KeystoreError> {
        let (key_package, public_key_package) = keystore.load(&self.key_password)?;
        let signer = FrostSigner::new(self.signer_id, key_package, public_key_package);
        *self.signer.write().await = Some(signer);
        Ok(())
    }
}

/// Create the router with all endpoints
pub fn create_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Health & info
        .route("/health", get(health_handler))
        .route("/info", get(info_handler))
        // Signing
        .route("/round1", post(round1_handler))
        .route("/round2", post(round2_handler))
        .route("/aggregate", post(aggregate_handler))
        // DKG
        .route("/dkg/round1", post(dkg_round1_handler))
        .route("/dkg/round2", post(dkg_round2_handler))
        .route("/dkg/finalize", post(dkg_finalize_handler))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

/// Health check endpoint
async fn health_handler(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let key_loaded = state.signer.read().await.is_some();
    Json(HealthResponse {
        status: if key_loaded { "ready" } else { "no_key" }.to_string(),
        signer_id: state.signer_id,
        key_loaded,
    })
}

/// Signer info endpoint
async fn info_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SignerInfo>, (StatusCode, Json<ErrorResponse>)> {
    let signer_guard = state.signer.read().await;
    let signer = signer_guard.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("KEY_NOT_LOADED", "Signer key not loaded")),
        )
    })?;

    let (threshold, total) = signer.threshold_info();
    Ok(Json(SignerInfo {
        signer_id: signer.signer_id(),
        public_key_share: hex::encode(signer.public_key_share()),
        group_public_key: hex::encode(signer.group_public_key()),
        threshold,
        total_participants: total,
    }))
}

/// FROST Round 1: Generate commitment
async fn round1_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Round1Request>,
) -> Result<Json<Round1Response>, (StatusCode, Json<ErrorResponse>)> {
    let signer_guard = state.signer.read().await;
    let signer = signer_guard.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("KEY_NOT_LOADED", "Signer key not loaded")),
        )
    })?;

    signer.round1(&request).map(Json).map_err(signing_error)
}

/// FROST Round 2: Generate signature share
async fn round2_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Round2Request>,
) -> Result<Json<Round2Response>, (StatusCode, Json<ErrorResponse>)> {
    let signer_guard = state.signer.read().await;
    let signer = signer_guard.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("KEY_NOT_LOADED", "Signer key not loaded")),
        )
    })?;

    signer.round2(&request).map(Json).map_err(signing_error)
}

/// DKG Round 1: Generate commitment
async fn dkg_round1_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DkgRound1Request>,
) -> Result<Json<DkgRound1Response>, (StatusCode, Json<ErrorResponse>)> {
    state.dkg.round1(&request).map(Json).map_err(dkg_error)
}

/// DKG Round 2: Generate shares
async fn dkg_round2_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DkgRound2Request>,
) -> Result<Json<DkgRound2Response>, (StatusCode, Json<ErrorResponse>)> {
    state.dkg.round2(&request).map(Json).map_err(dkg_error)
}

/// Aggregate signature shares into final Schnorr signature
async fn aggregate_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<AggregateRequest>,
) -> Result<Json<AggregateResponse>, (StatusCode, Json<ErrorResponse>)> {
    use crate::signing::aggregate_signatures;
    use frost_secp256k1_tr as frost;

    let signer_guard = state.signer.read().await;
    let signer = signer_guard.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("KEY_NOT_LOADED", "Signer key not loaded")),
        )
    })?;

    // Parse sighash
    let sighash_bytes = hex::decode(&request.sighash).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse::new("INVALID_HEX", format!("Invalid sighash hex: {}", e))),
        )
    })?;
    if sighash_bytes.len() != 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse::new("INVALID_SIGHASH", "Sighash must be 32 bytes")),
        ));
    }
    let mut sighash = [0u8; 32];
    sighash.copy_from_slice(&sighash_bytes);

    // Parse commitments and build signing package
    let mut frost_commitments: std::collections::BTreeMap<frost::Identifier, frost::round1::SigningCommitments> =
        std::collections::BTreeMap::new();
    let mut frost_shares: std::collections::BTreeMap<frost::Identifier, frost::round2::SignatureShare> =
        std::collections::BTreeMap::new();

    for (signer_id, commitment_hex) in &request.commitments {
        // Get FROST identifier
        let frost_id_hex = request.identifier_map.get(signer_id).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("MISSING_IDENTIFIER", format!("Missing identifier for signer {}", signer_id))),
            )
        })?;
        let frost_id_bytes = hex::decode(frost_id_hex).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("INVALID_HEX", format!("Invalid identifier hex: {}", e))),
            )
        })?;
        let identifier = frost::Identifier::deserialize(&frost_id_bytes).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("INVALID_IDENTIFIER", format!("Invalid FROST identifier: {}", e))),
            )
        })?;

        // Parse commitment
        let commitment_bytes = hex::decode(commitment_hex).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("INVALID_HEX", format!("Invalid commitment hex: {}", e))),
            )
        })?;
        let commitment = frost::round1::SigningCommitments::deserialize(&commitment_bytes).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("INVALID_COMMITMENT", format!("Invalid commitment: {}", e))),
            )
        })?;
        frost_commitments.insert(identifier, commitment);

        // Parse signature share
        if let Some(share_hex) = request.signature_shares.get(signer_id) {
            let share_bytes = hex::decode(share_hex).map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse::new("INVALID_HEX", format!("Invalid share hex: {}", e))),
                )
            })?;
            let share = frost::round2::SignatureShare::deserialize(&share_bytes).map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse::new("INVALID_SHARE", format!("Invalid signature share: {}", e))),
                )
            })?;
            frost_shares.insert(identifier, share);
        }
    }

    // Create signing package
    let signing_package = frost::SigningPackage::new(frost_commitments, &sighash);

    // Aggregate signatures
    let signature = aggregate_signatures(&signing_package, &frost_shares, &signer.public_key_package).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse::new("AGGREGATION_FAILED", format!("Failed to aggregate signatures: {}", e))),
        )
    })?;

    let group_pubkey = hex::encode(signer.group_public_key());

    tracing::info!(
        signature_len = signature.len(),
        group_pubkey = %group_pubkey,
        "Aggregated signature successfully"
    );

    Ok(Json(AggregateResponse {
        signature: hex::encode(signature),
        group_public_key: group_pubkey,
    }))
}

/// DKG Finalize: Compute key share and save
async fn dkg_finalize_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DkgFinalizeRequest>,
) -> Result<Json<DkgFinalizeResponse>, (StatusCode, Json<ErrorResponse>)> {
    let response = state
        .dkg
        .finalize(&request, &state.key_password)
        .map_err(dkg_error)?;

    // Load the newly saved key into the signer
    // Re-read from keystore to get the key packages
    let keystore = Keystore::new(
        format!("config/signer{}.key.enc", state.signer_id),
        state.signer_id,
    );

    if let Ok((key_package, public_key_package)) = keystore.load(&state.key_password) {
        let signer = FrostSigner::new(state.signer_id, key_package, public_key_package);
        *state.signer.write().await = Some(signer);
    }

    Ok(Json(response))
}

/// Convert signing error to HTTP response
fn signing_error(err: SigningError) -> (StatusCode, Json<ErrorResponse>) {
    let (code, status) = match &err {
        SigningError::SessionNotFound(_) => ("SESSION_NOT_FOUND", StatusCode::NOT_FOUND),
        SigningError::SessionAlreadyUsed => ("SESSION_USED", StatusCode::CONFLICT),
        SigningError::InvalidHex(_)
        | SigningError::InvalidSighashLength
        | SigningError::InvalidTweakLength
        | SigningError::MissingCommitment(_) => ("INVALID_INPUT", StatusCode::BAD_REQUEST),
        SigningError::FrostError(_) => ("FROST_ERROR", StatusCode::INTERNAL_SERVER_ERROR),
        SigningError::KeyNotLoaded => ("KEY_NOT_LOADED", StatusCode::SERVICE_UNAVAILABLE),
    };
    (status, Json(ErrorResponse::new(code, err.to_string())))
}

/// Convert DKG error to HTTP response
fn dkg_error(err: DkgError) -> (StatusCode, Json<ErrorResponse>) {
    let (code, status) = match &err {
        DkgError::CeremonyNotFound(_) => ("CEREMONY_NOT_FOUND", StatusCode::NOT_FOUND),
        DkgError::CeremonyAlreadyExists(_) => ("CEREMONY_EXISTS", StatusCode::CONFLICT),
        DkgError::Round1NotCompleted => ("ROUND1_NOT_COMPLETED", StatusCode::BAD_REQUEST),
        DkgError::InvalidHex(_) | DkgError::InvalidParticipantCount => {
            ("INVALID_INPUT", StatusCode::BAD_REQUEST)
        }
        DkgError::FrostError(_) => ("FROST_ERROR", StatusCode::INTERNAL_SERVER_ERROR),
        DkgError::KeystoreError(_) => ("KEYSTORE_ERROR", StatusCode::INTERNAL_SERVER_ERROR),
    };
    (status, Json(ErrorResponse::new(code, err.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn create_test_app() -> Router {
        let key_path = "/tmp/frost_test_key.enc";
        let keystore = Keystore::new(key_path, 1);
        let state = Arc::new(AppState::new(1, keystore, "test".to_string()));
        create_router(state)
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let app = create_test_app();

        let request = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_info_without_key() {
        let app = create_test_app();

        let request = Request::builder()
            .uri("/info")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
