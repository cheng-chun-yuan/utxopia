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

use solana_sdk::pubkey::Pubkey;

use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// Shared state for indexer routes
#[derive(Clone)]
pub struct IndexerAppState {
    pub store: Arc<EventStore>,
    pub tree_cache: Arc<TreeCache>,
    pub program_id: Pubkey,
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

/// Request body for POST /api/nullifiers/batch
#[derive(Debug, Deserialize)]
pub struct BatchNullifierRequest {
    pub hashes: Vec<String>,
}

/// Response for POST /api/nullifiers/batch
#[derive(Debug, Serialize)]
pub struct BatchNullifierResponse {
    /// Map of nullifier hash → spent (true/false)
    pub results: std::collections::HashMap<String, bool>,
}

/// Query params for GET /api/nullifiers
#[derive(Debug, Deserialize)]
pub struct NullifiersQuery {
    /// Return nullifiers with slot > since (for incremental sync)
    pub since: Option<i64>,
}

/// Response for GET /api/nullifiers — returns PDA addresses for client-side matching (privacy)
#[derive(Debug, Serialize)]
pub struct AllNullifiersResponse {
    /// Base58 PDA addresses derived from nullifier hashes
    pub pdas: Vec<String>,
    /// Total nullifier count (for integrity check against on-chain getProgramAccounts count)
    pub total: usize,
    /// Latest slot in the result set (client caches this for next ?since= call)
    pub latest_slot: i64,
}

/// Query params for announcements endpoint
#[derive(Debug, Deserialize)]
pub struct AnnouncementsQuery {
    pub since: Option<i64>,
}

/// Response for GET /api/announcements
#[derive(Debug, Serialize)]
pub struct AnnouncementsResponse {
    pub success: bool,
    pub announcements: Vec<super::storage::AnnouncementRow>,
    pub count: usize,
    pub latest_leaf_index: Option<i64>,
}

/// Response for GET /api/announcements/status
#[derive(Debug, Serialize)]
pub struct AnnouncementsStatusResponse {
    pub count: i64,
    pub latest_leaf_index: Option<i64>,
    pub tree_next_index: u64,
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
pub fn event_indexer_router(store: Arc<EventStore>, tree_cache: Arc<TreeCache>, program_id: Pubkey) -> Router {
    let state = IndexerAppState { store, tree_cache, program_id };

    Router::new()
        .route("/api/tree/leaves", get(get_leaves))
        .route("/api/tree/root", get(get_root))
        .route("/api/tree/status", get(get_status))
        .route("/api/tree/proof", get(get_proof))
        .route("/api/tree/sync", post(post_sync))
        .route("/api/nullifiers", get(get_all_nullifiers))
        .route("/api/nullifiers/batch", post(batch_nullifiers))
        .route("/api/nullifiers/{hash}", get(get_nullifier))
        .route("/ws/tree", get(ws_tree_handler))
        .route("/api/announcements", get(get_announcements))
        .route("/api/announcements/status", get(get_announcements_status))
        .route("/ws/announcements", get(ws_announcements_handler))
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

/// GET /api/nullifiers — returns spent nullifier PDA addresses for client-side matching.
/// Supports ?since=<slot> for incremental sync. Client caches latest_slot for next call.
async fn get_all_nullifiers(
    State(state): State<IndexerAppState>,
    Query(params): Query<NullifiersQuery>,
) -> Json<AllNullifiersResponse> {
    match state.store.get_nullifier_hashes_since(params.since) {
        Ok((hashes, total, latest_slot)) => {
            // Derive PDA address from each nullifier hash
            let pdas: Vec<String> = hashes
                .iter()
                .filter_map(|hash_hex| {
                    let bytes = hex::decode(hash_hex).ok()?;
                    if bytes.len() != 32 {
                        return None;
                    }
                    let (pda, _) = Pubkey::find_program_address(
                        &[b"nullifier", &bytes],
                        &state.program_id,
                    );
                    Some(pda.to_string())
                })
                .collect();
            Json(AllNullifiersResponse {
                pdas,
                total,
                latest_slot,
            })
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to list nullifiers");
            Json(AllNullifiersResponse {
                pdas: vec![],
                total: 0,
                latest_slot: 0,
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

async fn batch_nullifiers(
    State(state): State<IndexerAppState>,
    Json(body): Json<BatchNullifierRequest>,
) -> Json<BatchNullifierResponse> {
    let mut results = std::collections::HashMap::new();
    for hash in &body.hashes {
        let spent = match state.store.get_nullifier(hash) {
            Ok(Some(_)) => true,
            _ => false,
        };
        results.insert(hash.clone(), spent);
    }
    Json(BatchNullifierResponse { results })
}

async fn get_announcements(
    State(state): State<IndexerAppState>,
    Query(params): Query<AnnouncementsQuery>,
) -> Json<AnnouncementsResponse> {
    match state.store.get_announcements(params.since) {
        Ok(announcements) => {
            let count = announcements.len();
            let latest = state.store.get_latest_announcement_leaf_index().ok().flatten();
            Json(AnnouncementsResponse {
                success: true,
                announcements,
                count,
                latest_leaf_index: latest,
            })
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to get announcements");
            Json(AnnouncementsResponse {
                success: true,
                announcements: vec![],
                count: 0,
                latest_leaf_index: None,
            })
        }
    }
}

async fn get_announcements_status(
    State(state): State<IndexerAppState>,
) -> Json<AnnouncementsStatusResponse> {
    let count = state.store.get_announcement_count().unwrap_or(0);
    let latest = state.store.get_latest_announcement_leaf_index().ok().flatten();
    let tree_status = state.tree_cache.get_status().await;
    Json(AnnouncementsStatusResponse {
        count,
        latest_leaf_index: latest,
        tree_next_index: tree_status.next_index,
    })
}

// =============================================================================
// WebSocket Handlers
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
            if sender.send(Message::Text(json.into())).await.is_err() {
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

async fn ws_announcements_handler(
    ws: WebSocketUpgrade,
    State(state): State<IndexerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_announcements_socket(socket, state.tree_cache))
}

async fn handle_announcements_socket(socket: WebSocket, tree_cache: Arc<TreeCache>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = tree_cache.subscribe_announcements();

    let send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            let json = match serde_json::to_string(&update) {
                Ok(j) => j,
                Err(_) => continue,
            };
            if sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

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
