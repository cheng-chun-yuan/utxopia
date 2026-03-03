//! REST API + WebSocket endpoints for the event indexer

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// Shared state for indexer routes
#[derive(Clone)]
pub struct IndexerAppState {
    pub store: Arc<EventStore>,
    pub tree_cache: Arc<TreeCache>,
}

/// Query params for leaves endpoint
#[derive(Debug, Deserialize)]
pub struct LeavesQuery {
    /// Return leaves with leaf_index > since
    pub since: Option<i64>,
}

/// Query params for proof endpoint
#[derive(Debug, Deserialize)]
pub struct ProofQuery {
    /// Commitment hex string
    pub commitment: Option<String>,
}

/// Response for GET /api/tree/leaves
#[derive(Debug, Serialize)]
pub struct LeavesResponse {
    pub leaves: Vec<super::storage::LeafRow>,
    pub count: usize,
}

/// Response for GET /api/tree/root
#[derive(Debug, Serialize)]
pub struct RootResponse {
    pub next_index: i64,
}

/// Response for GET /api/tree/status
#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub root: String,
    pub next_index: u64,
    pub size: u64,
}

/// Response for GET /api/tree/proof
#[derive(Debug, Serialize)]
pub struct ProofResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commitment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leaf_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub siblings: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indices: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Response for GET /api/nullifiers/:hash
#[derive(Debug, Serialize)]
pub struct NullifierResponse {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<super::storage::NullifierRow>,
}

/// Response for POST /api/tree/sync
#[derive(Debug, Serialize)]
pub struct SyncResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Create the event indexer router with tree cache
pub fn event_indexer_router(store: Arc<EventStore>, tree_cache: Arc<TreeCache>) -> Router {
    let state = IndexerAppState { store, tree_cache };

    Router::new()
        .route("/api/tree/leaves", get(get_leaves))
        .route("/api/tree/root", get(get_root))
        .route("/api/tree/status", get(get_status))
        .route("/api/tree/proof", get(get_proof))
        .route("/api/tree/sync", post(post_sync))
        .route("/api/nullifiers/{hash}", get(get_nullifier))
        .route("/ws/tree", get(ws_tree_handler))
        .with_state(state)
}

// =============================================================================
// REST Handlers
// =============================================================================

async fn get_leaves(
    State(state): State<IndexerAppState>,
    Query(params): Query<LeavesQuery>,
) -> Json<LeavesResponse> {
    match state.store.get_leaves(params.since) {
        Ok(leaves) => {
            let count = leaves.len();
            Json(LeavesResponse { leaves, count })
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to get leaves");
            Json(LeavesResponse {
                leaves: vec![],
                count: 0,
            })
        }
    }
}

async fn get_root(State(state): State<IndexerAppState>) -> Json<RootResponse> {
    match state.store.get_next_leaf_index() {
        Ok(next_index) => Json(RootResponse { next_index }),
        Err(e) => {
            tracing::error!(error = %e, "Failed to get root");
            Json(RootResponse { next_index: 0 })
        }
    }
}

async fn get_status(State(state): State<IndexerAppState>) -> Json<StatusResponse> {
    let status = state.tree_cache.get_status().await;
    Json(StatusResponse {
        root: status.root,
        next_index: status.next_index,
        size: status.size,
    })
}

async fn get_proof(
    State(state): State<IndexerAppState>,
    Query(params): Query<ProofQuery>,
) -> Json<ProofResponse> {
    let commitment = match params.commitment {
        Some(c) => c,
        None => {
            return Json(ProofResponse {
                success: false,
                commitment: None,
                leaf_index: None,
                root: None,
                siblings: None,
                indices: None,
                error: Some("Missing 'commitment' query parameter".to_string()),
            });
        }
    };

    // Strip optional 0x prefix
    let commitment_hex = commitment.strip_prefix("0x").unwrap_or(&commitment);

    match state.tree_cache.get_proof(commitment_hex).await {
        Some(proof) => Json(ProofResponse {
            success: true,
            commitment: Some(proof.commitment),
            leaf_index: Some(proof.leaf_index),
            root: Some(proof.root),
            siblings: Some(proof.siblings),
            indices: Some(proof.indices),
            error: None,
        }),
        None => Json(ProofResponse {
            success: false,
            commitment: Some(commitment_hex.to_string()),
            leaf_index: None,
            root: None,
            siblings: None,
            indices: None,
            error: Some("Commitment not found in tree".to_string()),
        }),
    }
}

async fn post_sync(State(state): State<IndexerAppState>) -> Json<SyncResponse> {
    match state.tree_cache.force_rebuild().await {
        Ok(()) => {
            let status = state.tree_cache.get_status().await;
            Json(SyncResponse {
                success: true,
                root: Some(status.root),
                size: Some(status.size),
                error: None,
            })
        }
        Err(e) => {
            tracing::error!(error = %e, "Force sync failed");
            Json(SyncResponse {
                success: false,
                root: None,
                size: None,
                error: Some(e),
            })
        }
    }
}

async fn get_nullifier(
    State(state): State<IndexerAppState>,
    Path(hash): Path<String>,
) -> Json<NullifierResponse> {
    match state.store.get_nullifier(&hash) {
        Ok(Some(data)) => Json(NullifierResponse {
            found: true,
            data: Some(data),
        }),
        Ok(None) => Json(NullifierResponse {
            found: false,
            data: None,
        }),
        Err(e) => {
            tracing::error!(error = %e, "Failed to get nullifier");
            Json(NullifierResponse {
                found: false,
                data: None,
            })
        }
    }
}

// =============================================================================
// WebSocket Handler
// =============================================================================

async fn ws_tree_handler(
    ws: WebSocketUpgrade,
    State(state): State<IndexerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_tree_socket(socket, state.tree_cache))
}

async fn handle_tree_socket(socket: WebSocket, tree_cache: Arc<TreeCache>) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to tree updates
    let mut rx = tree_cache.subscribe();

    // Forward tree updates to the client
    let send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            let json = match serde_json::to_string(&update) {
                Ok(j) => j,
                Err(_) => continue,
            };
            if sender.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages (ping/pong, close)
    let recv_task = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}
