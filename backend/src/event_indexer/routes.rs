//! REST API + WebSocket endpoints for the event indexer

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::common::ws::run_broadcast_ws;

use solana_sdk::pubkey::Pubkey;

use crate::deposit_tracker::sqlite_db::SqliteDepositStore;

use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// Shared state for indexer routes
#[derive(Clone)]
pub struct IndexerAppState {
    pub store: Arc<EventStore>,
    pub tree_cache: Arc<TreeCache>,
    pub program_id: Pubkey,
    /// Optional deposit tracker store — reset endpoints clear this too
    pub deposit_store: Option<Arc<SqliteDepositStore>>,
}

/// Query params for proof endpoint
#[derive(Debug, Deserialize)]
pub struct ProofQuery {
    /// Commitment hex string
    pub commitment: Option<String>,
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
    pub leaf_count: i64,
    pub latest_leaf_index: Option<i64>,
    pub tree_next_index: u64,
    /// true when leaf_count != announcement count (indicates missing announcements)
    pub mismatch: bool,
}

/// A single transfer with nullifier PDAs derived
#[derive(Debug, Serialize)]
pub struct TransferItem {
    pub tx_signature: String,
    pub commitments: Vec<String>,
    pub leaf_indices: Vec<i64>,
    pub nullifier_hashes: Vec<String>,
    /// On-chain nullifier PDA addresses (base58)
    pub nullifier_pdas: Vec<String>,
    pub output_count: i64,
    pub input_count: i64,
    pub timestamp: i64,
    /// NullifierOperationType: 0=FullWithdrawal (unshield/redeem), 2=PrivateTransfer
    pub operation_type: i64,
    /// Aegis instruction discriminator: 14=transact, 15=unshield
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction_disc: Option<i64>,
    /// Token transfer amount in sats (unshield txs only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unshield_amount: Option<i64>,
    /// Token transfer recipient wallet (unshield txs only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unshield_recipient: Option<String>,
}

/// Response for GET /api/transfers
#[derive(Debug, Serialize)]
pub struct TransfersResponse {
    pub success: bool,
    pub transfers: Vec<TransferItem>,
    pub count: usize,
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
    event_indexer_router_with_deposits(store, tree_cache, program_id, None)
}

pub fn event_indexer_router_with_deposits(store: Arc<EventStore>, tree_cache: Arc<TreeCache>, program_id: Pubkey, deposit_store: Option<Arc<SqliteDepositStore>>) -> Router {
    let state = IndexerAppState { store, tree_cache, program_id, deposit_store };

    Router::new()
        // Tree
        .route("/api/tree/status", get(get_status))
        .route("/api/tree/proof", get(get_proof))
        .route("/api/tree/sync", post(post_sync))
        .route("/api/tree/reset", post(post_reset))
        // Nullifiers
        .route("/api/nullifiers", get(get_all_nullifiers))
        .route("/api/nullifiers/status", get(get_nullifiers_status))
        // Announcements
        .route("/api/announcements", get(get_announcements))
        .route("/api/announcements/status", get(get_announcements_status))
        // Transfers (grouped announcements + nullifier inputs)
        .route("/api/transfers", get(get_transfers))
        // Redemption tracking (reads from persistent JSON file)
        .route("/api/redemption/tracking", get(get_redemption_tracking))
        // Global
        .route("/api/sync", post(post_sync_all))
        .route("/api/reset", post(post_reset_all))
        // WebSocket
        .route("/ws/events", get(ws_events_handler))
        .route("/ws/tree", get(ws_tree_handler))
        .route("/ws/announcements", get(ws_announcements_handler))
        .with_state(state)
}

// =============================================================================
// REST Handlers
// =============================================================================

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

/// POST /api/tree/reset — clear all indexed data and rebuild from scratch.
/// Also clears stale deposit tracker data to prevent mismatched joins.
/// The indexer will re-backfill on its next poll cycle.
async fn post_reset(State(state): State<IndexerAppState>) -> Json<SyncResponse> {
    tracing::warn!("Resetting event indexer — clearing all data");
    if let Err(e) = state.store.clear_all() {
        return Json(SyncResponse {
            success: false,
            root: None,
            size: None,
            error: Some(format!("clear failed: {}", e)),
        });
    }
    // Also clear deposit tracker data to prevent stale leaf_index matches
    if let Some(ref deposit_store) = state.deposit_store {
        if let Err(e) = deposit_store.clear_all() {
            tracing::warn!(error = %e, "Failed to clear deposit tracker (non-fatal)");
        } else {
            tracing::info!("Deposit tracker data cleared");
        }
    }
    // Rebuild tree cache (now empty)
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
        Err(e) => Json(SyncResponse {
            success: false,
            root: None,
            size: None,
            error: Some(e),
        }),
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

async fn get_transfers(
    State(state): State<IndexerAppState>,
) -> Json<TransfersResponse> {
    match state.store.get_transfers() {
        Ok(rows) => {
            let count = rows.len();
            let transfers: Vec<TransferItem> = rows.into_iter().map(|t| {
                let nullifier_pdas: Vec<String> = t.nullifier_hashes.iter()
                    .filter_map(|hash_hex| {
                        let bytes = hex::decode(hash_hex).ok()?;
                        if bytes.len() != 32 { return None; }
                        let (pda, _) = Pubkey::find_program_address(
                            &[b"nullifier", &bytes],
                            &state.program_id,
                        );
                        Some(pda.to_string())
                    })
                    .collect();
                TransferItem {
                    tx_signature: t.tx_signature,
                    commitments: t.commitments,
                    leaf_indices: t.leaf_indices,
                    nullifier_hashes: t.nullifier_hashes,
                    nullifier_pdas,
                    output_count: t.output_count,
                    input_count: t.input_count,
                    timestamp: t.timestamp,
                    operation_type: t.operation_type,
                    instruction_disc: t.instruction_disc,
                    unshield_amount: t.unshield_amount,
                    unshield_recipient: t.unshield_recipient,
                }
            }).collect();
            Json(TransfersResponse {
                success: true,
                transfers,
                count,
            })
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to get transfers");
            Json(TransfersResponse {
                success: true,
                transfers: vec![],
                count: 0,
            })
        }
    }
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
    let leaf_count = state.store.get_leaf_count().unwrap_or(0);
    let latest = state.store.get_latest_announcement_leaf_index().ok().flatten();
    let tree_status = state.tree_cache.get_status().await;
    let mismatch = leaf_count != count;
    if mismatch {
        tracing::warn!(
            leaf_count,
            announcement_count = count,
            "Leaf/announcement count mismatch — some announcements may be missing"
        );
    }
    Json(AnnouncementsStatusResponse {
        count,
        leaf_count,
        latest_leaf_index: latest,
        tree_next_index: tree_status.next_index,
        mismatch,
    })
}

/// GET /api/nullifiers/status
async fn get_nullifiers_status(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    let (_, total, latest_slot) = state
        .store
        .get_nullifier_hashes_since(None)
        .unwrap_or_default();
    Json(serde_json::json!({
        "count": total,
        "latest_slot": latest_slot,
    }))
}

/// POST /api/sync — force sync all resources
async fn post_sync_all(State(state): State<IndexerAppState>) -> Json<SyncResponse> {
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
            tracing::error!(error = %e, "Sync all failed");
            Json(SyncResponse {
                success: false,
                root: None,
                size: None,
                error: Some(e),
            })
        }
    }
}

/// POST /api/reset — clear all data and rebuild
async fn post_reset_all(State(state): State<IndexerAppState>) -> Json<SyncResponse> {
    tracing::warn!("Resetting all indexed data");
    if let Err(e) = state.store.clear_all() {
        return Json(SyncResponse {
            success: false,
            root: None,
            size: None,
            error: Some(format!("clear failed: {}", e)),
        });
    }
    // Also clear deposit tracker data to prevent stale leaf_index matches
    if let Some(ref deposit_store) = state.deposit_store {
        if let Err(e) = deposit_store.clear_all() {
            tracing::warn!(error = %e, "Failed to clear deposit tracker (non-fatal)");
        } else {
            tracing::info!("Deposit tracker data cleared");
        }
    }
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
        Err(e) => Json(SyncResponse {
            success: false,
            root: None,
            size: None,
            error: Some(e),
        }),
    }
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

async fn handle_tree_socket(socket: axum::extract::ws::WebSocket, tree_cache: Arc<TreeCache>) {
    let rx = tree_cache.subscribe();
    run_broadcast_ws(socket, rx, None, "").await;
}

async fn ws_announcements_handler(
    ws: WebSocketUpgrade,
    State(state): State<IndexerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_announcements_socket(socket, state.tree_cache))
}

async fn handle_announcements_socket(socket: axum::extract::ws::WebSocket, tree_cache: Arc<TreeCache>) {
    let rx = tree_cache.subscribe_announcements();
    run_broadcast_ws(socket, rx, None, "").await;
}

/// Unified event stream — multiplexes tree, nullifier, and announcement updates
async fn ws_events_handler(
    ws: WebSocketUpgrade,
    State(state): State<IndexerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_events_socket(socket, state.tree_cache))
}

async fn handle_events_socket(socket: WebSocket, tree_cache: Arc<TreeCache>) {
    let (mut sender, mut receiver) = socket.split();

    let mut tree_rx = tree_cache.subscribe();
    let mut null_rx = tree_cache.subscribe_nullifiers();
    let mut ann_rx = tree_cache.subscribe_announcements();

    let send_task = tokio::spawn(async move {
        loop {
            let json = tokio::select! {
                Ok(update) = tree_rx.recv() => serde_json::to_string(&update).ok(),
                Ok(update) = null_rx.recv() => serde_json::to_string(&update).ok(),
                Ok(update) = ann_rx.recv() => serde_json::to_string(&update).ok(),
                else => break,
            };
            if let Some(json) = json {
                if sender.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
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

// =============================================================================
// Redemption Tracking (reads from persistent JSON file)
// =============================================================================

/// GET /api/redemption/tracking — expose local redemption tracking state
///
/// Reads `redemption_tracking.json` from disk (written atomically by the
/// redemption watcher). Returns BTC txids, status, timestamps, and errors
/// keyed by PDA address for the frontend to join with on-chain PDA data.
async fn get_redemption_tracking() -> Json<serde_json::Value> {
    let path = std::path::Path::new("redemption_tracking.json");
    if !path.exists() {
        return Json(serde_json::json!({
            "success": true,
            "tracking": [],
            "count": 0,
        }));
    }

    match std::fs::read_to_string(path) {
        Ok(data) => {
            match serde_json::from_str::<Vec<serde_json::Value>>(&data) {
                Ok(entries) => {
                    let count = entries.len();
                    Json(serde_json::json!({
                        "success": true,
                        "tracking": entries,
                        "count": count,
                    }))
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to parse redemption tracking JSON");
                    Json(serde_json::json!({
                        "success": false,
                        "tracking": [],
                        "count": 0,
                        "error": format!("Parse error: {}", e),
                    }))
                }
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to read redemption tracking file");
            Json(serde_json::json!({
                "success": false,
                "tracking": [],
                "count": 0,
                "error": format!("Read error: {}", e),
            }))
        }
    }
}
