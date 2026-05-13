//! HTTP routes for the PoI association service.
//!
//!   GET  /api/poi/status              — current root + leaf count
//!   GET  /api/poi/inclusion?commitment=<hex>  — Merkle inclusion proof
//!   POST /api/poi/add  { "commitment": "<hex>" } — admin-only; add to set
//!
//! Authentication for `/api/poi/add` is left to the deployment-level
//! middleware (API key + IP allowlist). For Phase 3c v1 it's not enforced
//! here.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use super::{InclusionProof, PoIError, PoIService, PoIStatus};

#[derive(Debug, Deserialize)]
pub struct InclusionQuery {
    pub commitment: String,
}

#[derive(Debug, Deserialize)]
pub struct AddBody {
    pub commitment: String,
}

pub fn router(service: PoIService) -> Router {
    Router::new()
        .route("/api/poi/status", get(handle_status))
        .route("/api/poi/inclusion", get(handle_inclusion))
        .route("/api/poi/add", post(handle_add))
        .with_state(service)
}

async fn handle_status(State(svc): State<PoIService>) -> impl IntoResponse {
    match svc.status() {
        Ok(s) => (StatusCode::OK, Json::<PoIStatus>(s)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn handle_inclusion(
    State(svc): State<PoIService>,
    Query(q): Query<InclusionQuery>,
) -> impl IntoResponse {
    let commitment = match parse_hex32(&q.commitment) {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad commitment hex").into_response(),
    };

    match svc.inclusion_proof(&commitment) {
        Ok(proof) => (StatusCode::OK, Json::<InclusionProof>(proof)).into_response(),
        Err(PoIError::NotFound) => (StatusCode::NOT_FOUND, "not in association set").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn handle_add(
    State(svc): State<PoIService>,
    Json(body): Json<AddBody>,
) -> impl IntoResponse {
    let commitment = match parse_hex32(&body.commitment) {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad commitment hex").into_response(),
    };
    svc.add_commitment(commitment);
    (StatusCode::OK, "ok").into_response()
}

fn parse_hex32(s: &str) -> Result<[u8; 32], &'static str> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 {
        return Err("expected 64 hex chars");
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| "bad hex")?;
    }
    Ok(out)
}
