//! Axum HTTP server for FROST signer
//!
//! Exposes signing and DKG endpoints for threshold operations.

use crate::audit::AuditLog;
use crate::dkg::{DkgError, DkgParticipant};
use crate::keystore::Keystore;
use crate::policy::{DuplicateTracker, SigningPolicy};
use crate::signing::{FrostSigner, SigningError};
use crate::types::{
    AggregateRequest, AggregateResponse, DkgFinalizeRequest, DkgFinalizeResponse,
    DkgRound1Request, DkgRound1Response, DkgRound2Request, DkgRound2Response,
    ErrorResponse, HealthResponse, Round1Request, Round1Response, Round2Request,
    Round2Response, SignerInfo, VerifyCommitmentsRequest, VerifyCommitmentsResponse,
};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use crate::types::SolanaVerification;
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
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
    /// Signing policy (None = no policy enforcement)
    pub policy: Option<SigningPolicy>,
    /// Audit log
    pub audit: Arc<AuditLog>,
    /// Duplicate tracker for preventing double-signing
    pub duplicate_tracker: Option<Arc<DuplicateTracker>>,
    /// Session-level verification data (session_id -> (requester, nonce)), for recording after round2
    pub session_verifications: RwLock<HashMap<uuid::Uuid, (String, u64)>>,
}

impl AppState {
    /// Create new app state
    pub fn new(signer_id: u16, keystore: Keystore, key_password: String) -> Self {
        Self {
            signer_id,
            signer: RwLock::new(None),
            dkg: DkgParticipant::new(signer_id, keystore),
            key_password,
            policy: None,
            audit: Arc::new(AuditLog::new(None)),
            duplicate_tracker: None,
            session_verifications: RwLock::new(HashMap::new()),
        }
    }

    /// Set signing policy
    pub fn with_policy(mut self, policy: SigningPolicy) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Set audit log
    pub fn with_audit(mut self, audit: AuditLog) -> Self {
        self.audit = Arc::new(audit);
        self
    }

    /// Set duplicate tracker
    pub fn with_duplicate_tracker(mut self, tracker: Arc<DuplicateTracker>) -> Self {
        self.duplicate_tracker = Some(tracker);
        self
    }

    /// Load existing key share
    pub async fn load_key(&self, keystore: &Keystore) -> Result<(), crate::keystore::KeystoreError> {
        let (key_package, public_key_package) = keystore.load(&self.key_password)?;
        let signer = FrostSigner::new(self.signer_id, key_package, public_key_package);
        *self.signer.write().await = Some(signer);
        Ok(())
    }
}

/// Simple in-memory rate limiter for signing endpoints
pub struct SigningRateLimiter {
    entries: RwLock<HashMap<String, (u32, Instant)>>,
    max_requests: u32,
    window: Duration,
}

impl SigningRateLimiter {
    pub fn new(max_requests: u32, window_secs: u64) -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            max_requests,
            window: Duration::from_secs(window_secs),
        }
    }

    pub async fn check(&self, client_id: &str) -> bool {
        let mut entries = self.entries.write().await;
        let now = Instant::now();
        let entry = entries.entry(client_id.to_string()).or_insert((0, now));
        if now.duration_since(entry.1) >= self.window {
            *entry = (1, now);
            return true;
        }
        if entry.0 < self.max_requests {
            entry.0 += 1;
            true
        } else {
            false
        }
    }
}

/// Rate limiting middleware for signing endpoints (20 requests/minute)
async fn signing_rate_limit(
    State(limiter): State<Arc<SigningRateLimiter>>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let client_id = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("unknown").trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    if !limiter.check(&client_id).await {
        tracing::warn!(client = %client_id, "signing rate limit exceeded");
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    Ok(next.run(request).await)
}

/// Create the router with all endpoints
pub fn create_router(state: Arc<AppState>) -> Router {
    // CORS: configurable via FROST_ALLOWED_ORIGIN env var
    let cors = match env::var("FROST_ALLOWED_ORIGIN") {
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
            tracing::warn!("FROST_ALLOWED_ORIGIN not set — defaulting to localhost only");
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(
                    vec!["http://localhost:3000".parse().unwrap()]
                ))
                .allow_methods(Any)
                .allow_headers(Any)
        }
    };

    // Public routes (no auth required)
    let public_routes = Router::new()
        .route("/health", get(health_handler));

    // Rate limiter for signing endpoints (20 signing requests per minute)
    let signing_limiter = Arc::new(SigningRateLimiter::new(20, 60));

    // Signing routes (auth + rate limit)
    let signing_routes = Router::new()
        .route("/round1", post(round1_handler))
        .route("/round2", post(round2_handler))
        .route("/aggregate", post(aggregate_handler))
        .layer(middleware::from_fn_with_state(signing_limiter, signing_rate_limit))
        .layer(middleware::from_fn(api_key_auth))
        .with_state(state.clone());

    // Other protected routes (auth only, no rate limit)
    let protected_routes = Router::new()
        .route("/info", get(info_handler))
        .route("/verify-commitments", post(verify_commitments_handler))
        .route("/dkg/round1", post(dkg_round1_handler))
        .route("/dkg/round2", post(dkg_round2_handler))
        .route("/dkg/finalize", post(dkg_finalize_handler))
        .layer(middleware::from_fn(api_key_auth));

    public_routes
        .merge(signing_routes)
        .merge(protected_routes)
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

/// API key authentication middleware
///
/// Checks `X-API-Key` header against `FROST_API_KEY` env var.
/// FROST_API_KEY must be set — server logs a warning on every request if missing.
async fn api_key_auth(headers: HeaderMap, request: Request, next: Next) -> Result<Response, StatusCode> {
    match env::var("FROST_API_KEY") {
        Ok(expected_key) if !expected_key.is_empty() => {
            let provided = headers
                .get("X-API-Key")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");

            // Constant-time comparison to prevent timing attacks
            let expected_bytes = expected_key.as_bytes();
            let provided_bytes = provided.as_bytes();
            let matches = expected_bytes.len() == provided_bytes.len()
                && expected_bytes
                    .iter()
                    .zip(provided_bytes.iter())
                    .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                    == 0;

            if !matches {
                tracing::warn!("rejected request with invalid API key");
                return Err(StatusCode::UNAUTHORIZED);
            }
        }
        _ => {
            tracing::error!("FROST_API_KEY not set — rejecting request (set FROST_API_KEY env var)");
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    Ok(next.run(request).await)
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
///
/// If a signing policy is configured, verifies the transaction context
/// before allowing the signer to generate a commitment.
async fn round1_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<Round1Request>,
) -> Result<Json<Round1Response>, (StatusCode, Json<ErrorResponse>)> {
    // Enforce signing policy if configured
    if let Some(ref policy) = state.policy {
        let session_id = request.session_id.to_string();
        match policy.verify(&request).await {
            Ok(info) => {
                state.audit.log_policy(
                    &session_id,
                    &request.sighash,
                    "allow",
                    None,
                    if info.destinations.is_empty() { None } else { Some(info.destinations) },
                    Some(info.total_output_sats),
                    Some(info.fee_sats),
                );
                tracing::info!(
                    session = %session_id,
                    output_sats = info.total_output_sats,
                    fee_sats = info.fee_sats,
                    "policy check passed"
                );

                // Store verification data for duplicate tracking after round2
                if let Some(ref verification) = request.solana_verification {
                    if let SolanaVerification::Withdrawal { ref requester, nonce, .. } = verification {
                        state.session_verifications.write().await
                            .insert(request.session_id, (requester.clone(), *nonce));
                    }
                }
            }
            Err(e) => {
                let reason = e.to_string();
                state.audit.log_policy(
                    &session_id,
                    &request.sighash,
                    "deny",
                    Some(&reason),
                    None,
                    None,
                    None,
                );
                tracing::warn!(
                    session = %session_id,
                    error = %reason,
                    "policy check REJECTED signing request"
                );
                return Err(policy_error(e));
            }
        }
    }

    let signer_guard = state.signer.read().await;
    let signer = signer_guard.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("KEY_NOT_LOADED", "Signer key not loaded")),
        )
    })?;

    let result = signer.round1(&request).map(Json).map_err(signing_error);

    // Audit log the round1 result
    let session_id = request.session_id.to_string();
    match &result {
        Ok(_) => state.audit.log_signing(&session_id, "round1", state.signer_id, "ok", None),
        Err((_, ref err)) => state.audit.log_signing(&session_id, "round1", state.signer_id, "error", Some(&err.message)),
    }

    result
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

    let session_id = request.session_id;
    let result = signer.round2(&request).map(Json).map_err(signing_error);

    // On successful round2, record the signing for duplicate prevention
    if result.is_ok() {
        if let Some(ref tracker) = state.duplicate_tracker {
            let verifications = state.session_verifications.read().await;
            if let Some((requester, nonce)) = verifications.get(&session_id) {
                tracker.record(requester, *nonce);
                state.audit.log_signing_complete(
                    &session_id.to_string(),
                    state.signer_id,
                    requester,
                    *nonce,
                );
                tracing::info!(
                    session = %session_id,
                    requester = %requester,
                    nonce = nonce,
                    "recorded signing completion for duplicate prevention"
                );
            }
        }
        // Clean up session verification data
        state.session_verifications.write().await.remove(&session_id);
    }

    result
}

/// Broadcast channel: verify commitments digest
async fn verify_commitments_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<VerifyCommitmentsRequest>,
) -> Result<Json<VerifyCommitmentsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let signer_guard = state.signer.read().await;
    let signer = signer_guard.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("KEY_NOT_LOADED", "Signer key not loaded")),
        )
    })?;

    signer
        .verify_commitments(&request)
        .map(Json)
        .map_err(signing_error)
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

    // Parse optional merkle root for BIP-341 tweaked aggregation
    let merkle_root_bytes = match &request.merkle_root {
        Some(hex_str) => Some(hex::decode(hex_str).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("INVALID_HEX", format!("Invalid merkle_root hex: {}", e))),
            )
        })?),
        None => None,
    };

    // Aggregate signatures (with optional Taproot tweak)
    let signature = crate::signing::aggregate_signatures_with_tweak(
        &signing_package,
        &frost_shares,
        &signer.public_key_package,
        merkle_root_bytes.as_deref(),
    ).map_err(|e| {
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

/// Convert policy error to HTTP response
fn policy_error(err: crate::policy::PolicyError) -> (StatusCode, Json<ErrorResponse>) {
    use crate::policy::PolicyError;
    let (code, status) = match &err {
        PolicyError::ContextRequired => ("POLICY_CONTEXT_REQUIRED", StatusCode::BAD_REQUEST),
        PolicyError::SighashMismatch { .. } => ("POLICY_SIGHASH_MISMATCH", StatusCode::FORBIDDEN),
        PolicyError::DestinationNotAllowed { .. } => ("POLICY_DESTINATION_NOT_ALLOWED", StatusCode::FORBIDDEN),
        PolicyError::AmountExceeded { .. } => ("POLICY_AMOUNT_EXCEEDED", StatusCode::FORBIDDEN),
        PolicyError::FeeExceeded { .. } => ("POLICY_FEE_EXCEEDED", StatusCode::FORBIDDEN),
        PolicyError::UtxoNotFound { .. } => ("POLICY_UTXO_NOT_FOUND", StatusCode::FORBIDDEN),
        PolicyError::UtxoAmountMismatch { .. } => ("POLICY_UTXO_AMOUNT_MISMATCH", StatusCode::FORBIDDEN),
        PolicyError::InvalidTx(_) | PolicyError::InvalidPrevout(_) | PolicyError::InvalidSighash(_) => {
            ("POLICY_INVALID_INPUT", StatusCode::BAD_REQUEST)
        }
        PolicyError::InputIndexOutOfRange { .. } => ("POLICY_INVALID_INPUT", StatusCode::BAD_REQUEST),
        PolicyError::EsploraError(_) => ("POLICY_ESPLORA_ERROR", StatusCode::BAD_GATEWAY),
        PolicyError::SolanaRedemptionNotFound(_) => ("POLICY_SOLANA_REDEMPTION_NOT_FOUND", StatusCode::FORBIDDEN),
        PolicyError::SolanaRedemptionMismatch(_) => ("POLICY_SOLANA_REDEMPTION_MISMATCH", StatusCode::FORBIDDEN),
        PolicyError::SolanaRedemptionWrongStatus(_) => ("POLICY_SOLANA_REDEMPTION_WRONG_STATUS", StatusCode::FORBIDDEN),
        PolicyError::SolanaRpcError(_) => ("POLICY_SOLANA_RPC_ERROR", StatusCode::BAD_GATEWAY),
        PolicyError::SolanaVerificationFailed(_) => ("POLICY_SOLANA_VERIFICATION_FAILED", StatusCode::FORBIDDEN),
        PolicyError::DuplicateSigning { .. } => ("POLICY_DUPLICATE_SIGNING", StatusCode::CONFLICT),
        PolicyError::CrossValidationFailed(_) => ("POLICY_CROSS_VALIDATION_FAILED", StatusCode::FORBIDDEN),
        PolicyError::AlreadyPaid { .. } => ("POLICY_ALREADY_PAID", StatusCode::FORBIDDEN),
        PolicyError::InvalidAddress { .. } => ("POLICY_INVALID_ADDRESS", StatusCode::FORBIDDEN),
    };
    (status, Json(ErrorResponse::new(code, err.to_string())))
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
        DkgError::InvalidHex(_) | DkgError::InvalidParticipantCount | DkgError::MissingX25519Pubkey(_) => {
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
        // Set API key so auth middleware doesn't block the request
        env::set_var("FROST_API_KEY", "test-key");
        let app = create_test_app();

        let request = Request::builder()
            .uri("/info")
            .header("X-API-Key", "test-key")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
