//! REST API + WebSocket endpoints for the event indexer
//!
//! Endpoints:
//! - GET /api/tree/status — merkle tree root, leaf count, depth
//! - GET /api/tree/proof/:leaf_index — merkle proof for a leaf
//! - GET /api/tree/leaves — all leaves with commitments
//! - GET /api/nullifiers — all spent nullifiers
//! - GET /api/nullifiers/:hash — check if nullifier is spent
//! - GET /api/transfers — all JoinSplit transactions with inputs/outputs
//! - GET /api/announcements — stealth announcements (type 0=deposit, 1=transfer)
//! - GET /api/redemptions — completed redemption events
//! - WS /ws — real-time event stream (leaves, nullifiers, announcements)

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
use tokio::sync::RwLock;

use crate::common::ws::run_broadcast_ws;

use solana_sdk::pubkey::Pubkey;

use crate::deposit_tracker::sqlite_db::SqliteDepositStore;

use super::reconciler::ReconciliationResult;
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
    /// Latest reconciliation result (updated by background Reconciler)
    pub reconciler_status: Arc<RwLock<Option<ReconciliationResult>>>,
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
    /// "confirmed" when timestamp > 0, "processing" when not yet confirmed
    pub status: String,
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
    /// Token ID hex (from on-chain event, identifies which token)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_id: Option<String>,
    /// Event-derived transfer type: "private_transfer", "unshield", "redeem", "deposit"
    pub transfer_type: String,
    /// Protocol fee deducted from unshield (from UnshieldMeta v2 event)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unshield_fee: Option<i64>,
    /// Net payout after fee (from UnshieldMeta v2 event)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unshield_payout: Option<i64>,
    /// Per-output detail for multi-output unshield/withdraw
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unshield_outputs: Option<Vec<serde_json::Value>>,
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
    event_indexer_router_with_deposits(store, tree_cache, program_id, None, Arc::new(RwLock::new(None)))
}

pub fn event_indexer_router_with_deposits(
    store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
    program_id: Pubkey,
    deposit_store: Option<Arc<SqliteDepositStore>>,
    reconciler_status: Arc<RwLock<Option<ReconciliationResult>>>,
) -> Router {
    let state = IndexerAppState { store, tree_cache, program_id, deposit_store, reconciler_status };

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
        // Unified explorer: all tx types (shield + transfer + unshield + withdraw)
        .route("/api/explorer/transactions", get(get_explorer_transactions))
        // Redemption tracking (reads from SQLite tracking database)
        .route("/api/redemption/tracking", get(get_redemption_tracking))
        // Completed redemptions (from on-chain events, backend-independent)
        .route("/api/redemption/completed", get(get_completed_redemptions))
        // Requested redemptions (from on-chain events 0x08)
        .route("/api/redemption/requested", get(get_requested_redemptions))
        // Processing redemptions (from on-chain events 0x0A)
        .route("/api/redemption/processing", get(get_processing_redemptions))
        // Consolidated: all redemption data in one response
        .route("/api/redemption/all", get(get_all_redemptions))
        // Reconciliation
        .route("/api/reconciliation/status", get(get_reconciliation_status))
        // Pool stats (cached, for frontend landing page)
        .route("/api/pool/stats", get(get_pool_stats))
        // Unified indexer status (announcements + nullifiers + transfers)
        .route("/api/indexer/status", get(get_indexer_status))
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
// Helpers
// =============================================================================

/// Derive on-chain nullifier PDA addresses (base58) from hex-encoded nullifier hashes.
fn derive_nullifier_pdas(hashes: &[String], program_id: &Pubkey) -> Vec<String> {
    hashes
        .iter()
        .filter_map(|hash_hex| {
            let bytes = hex::decode(hash_hex).ok()?;
            if bytes.len() != 32 {
                return None;
            }
            let (pda, _) = Pubkey::find_program_address(&[b"nullifier", &bytes], program_id);
            Some(pda.to_string())
        })
        .collect()
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
            let pdas = derive_nullifier_pdas(&hashes, &state.program_id);
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
                let nullifier_pdas = derive_nullifier_pdas(&t.nullifier_hashes, &state.program_id);
                TransferItem {
                    tx_signature: t.tx_signature,
                    commitments: t.commitments,
                    leaf_indices: t.leaf_indices,
                    nullifier_hashes: t.nullifier_hashes,
                    nullifier_pdas,
                    output_count: t.output_count,
                    input_count: t.input_count,
                    timestamp: t.timestamp,
                    status: t.status,
                    operation_type: t.operation_type,
                    instruction_disc: t.instruction_disc,
                    unshield_amount: t.unshield_amount,
                    unshield_recipient: t.unshield_recipient,
                    token_id: t.token_id,
                    transfer_type: t.transfer_type,
                    unshield_fee: t.unshield_fee,
                    unshield_payout: t.unshield_payout,
                    unshield_outputs: t.unshield_outputs,
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

/// GET /api/indexer/status — unified status: announcements + nullifiers + transfers + tree + reconciler
///
/// If a drift is detected between on-chain state and the local tree, a non-blocking
/// tree rebuild is triggered automatically.
async fn get_indexer_status(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    // Announcements
    let announcement_count = state.store.get_announcement_count().unwrap_or(0);
    let leaf_count = state.store.get_leaf_count().unwrap_or(0);
    let latest_leaf = state.store.get_latest_announcement_leaf_index().ok().flatten();
    let ann_mismatch = leaf_count != announcement_count;

    // Nullifiers
    let (_, nullifier_total, nullifier_latest_slot) = state
        .store
        .get_nullifier_hashes_since(None)
        .unwrap_or_default();

    // Transfers
    let transfer_count = state.store.get_nullifier_count().unwrap_or(0);
    let deposit_count = state.store.get_deposit_count().unwrap_or(0);

    // Tree
    let tree_status = state.tree_cache.get_status().await;

    // Reconciler (on-chain vs local)
    let recon = state.reconciler_status.read().await;
    let (recon_json, tree_drift) = match recon.as_ref() {
        Some(r) => {
            let drift = !r.leaves_match || !r.deposits_match;
            (serde_json::json!({
                "on_chain_leaves": r.on_chain.tree_next_index,
                "local_leaves": r.local_leaf_count,
                "leaves_match": r.leaves_match,
                "deposits_match": r.deposits_match,
                "recovery_triggered": r.recovery_triggered,
                "checked_at": r.checked_at,
                "in_sync": !drift,
            }), drift)
        }
        None => (serde_json::json!(null), false),
    };
    drop(recon);

    // Auto-trigger tree rebuild on drift (non-blocking)
    let mut rebuild_triggered = false;
    if tree_drift || ann_mismatch {
        let tc = state.tree_cache.clone();
        rebuild_triggered = true;
        tokio::spawn(async move {
            if let Err(e) = tc.force_rebuild().await {
                tracing::error!(error = %e, "Auto-rebuild from /api/indexer/status failed");
            } else {
                tracing::info!("Auto-rebuild from /api/indexer/status succeeded");
            }
        });
    }

    Json(serde_json::json!({
        "announcements": {
            "count": announcement_count,
            "leaf_count": leaf_count,
            "latest_leaf_index": latest_leaf,
            "mismatch": ann_mismatch,
        },
        "nullifiers": {
            "count": nullifier_total,
            "latest_slot": nullifier_latest_slot,
        },
        "transactions": {
            "deposit_count": deposit_count,
            "transfer_count": transfer_count,
        },
        "tree": {
            "root": tree_status.root,
            "size": tree_status.size,
            "next_index": tree_status.next_index,
        },
        "reconciler": recon_json,
        "rebuild_triggered": rebuild_triggered,
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

/// GET /api/reconciliation/status — latest on-chain vs local state comparison
async fn get_reconciliation_status(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    let status = state.reconciler_status.read().await;
    match status.as_ref() {
        Some(result) => Json(serde_json::json!({
            "success": true,
            "reconciliation": result,
        })),
        None => Json(serde_json::json!({
            "success": true,
            "reconciliation": null,
            "message": "No reconciliation check has run yet",
        })),
    }
}

/// GET /api/pool/stats — cached pool statistics for frontend
///
/// Returns on-chain pool state (from reconciler cache) + local event counts.
/// Cached by reconciler interval (~30s), no RPC calls per request.
async fn get_pool_stats(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    let recon = state.reconciler_status.read().await;

    let (on_chain, local_leaves, local_nullifiers) = match recon.as_ref() {
        Some(r) => (Some(&r.on_chain), r.local_leaf_count, r.local_nullifier_count),
        None => (None, 0, 0),
    };

    // Local event counts (always fresh from SQLite)
    let local_deposits = state.store.get_deposit_count().unwrap_or(0);
    let local_transfers = state.store.get_nullifier_count().unwrap_or(0);

    // Per-token TVL from deposit announcements
    let token_tvl: Vec<serde_json::Value> = state.store.get_token_tvl()
        .unwrap_or_default()
        .into_iter()
        .map(|(token_id_hex, total)| serde_json::json!({
            "tokenId": token_id_hex,
            "totalShielded": total,
        }))
        .collect();

    Json(serde_json::json!({
        "success": true,
        "onChain": on_chain.map(|oc| serde_json::json!({
            "depositCount": oc.deposit_count,
            "totalMinted": oc.total_minted,
            "totalBurned": oc.total_burned,
            "totalShielded": oc.total_shielded,
            "pendingRedemptions": oc.pending_redemptions,
            "treeNextIndex": oc.tree_next_index,
            "treeRoot": oc.tree_root,
        })),
        "local": {
            "leafCount": local_leaves,
            "depositCount": local_deposits,
            "nullifierCount": local_nullifiers,
            "transferCount": local_transfers,
        },
        "tokenTVL": token_tvl,
    }))
}

/// GET /api/explorer/transactions — unified endpoint: shield + transfer + unshield + withdraw
///
/// Combines deposit announcements (type=0 → shield) with transfers (transfer/unshield/withdraw)
/// into a single sorted response. This is the single endpoint the frontend needs.
async fn get_explorer_transactions(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    let mut transactions = Vec::new();

    // 1. Shield transactions from deposit announcements (type=0)
    if let Ok(announcements) = state.store.get_announcements(None) {
        for a in announcements.iter().filter(|a| a.announcement_type == 0) {
            // encrypted_amount is hex string of LE u64
            let amount = hex::decode(&a.encrypted_amount).ok()
                .filter(|b| b.len() >= 8)
                .map(|b| u64::from_le_bytes(b[..8].try_into().unwrap_or([0; 8])))
                .unwrap_or(0);

            transactions.push(serde_json::json!({
                "txSignature": a.tx_signature,
                "type": "shield",
                "tokenId": &a.token_id,
                "timestamp": a.block_time,
                "status": "confirmed",
                "inputs": [{
                    "grossAmount": a.deposit_gross_amount.or(a.btc_deposit_amount_sats),
                    "fee": a.deposit_fee,
                    "netAmount": amount,
                    "btcDepositTxid": a.btc_deposit_txid,
                    "btcSweepTxid": a.btc_sweep_txid,
                }],
                "outputs": [{
                    "type": "commitment",
                    "commitment": &a.commitment,
                    "leafIndex": a.leaf_index,
                    "amount": amount,
                }],
            }));
        }
    }

    // 2. Transfer/unshield/withdraw from nullifier-based transfers
    if let Ok(rows) = state.store.get_transfers() {
        for t in rows {
            let nullifier_pdas = derive_nullifier_pdas(&t.nullifier_hashes, &state.program_id);

            let mut outputs: Vec<serde_json::Value> = Vec::new();

            // Commitment outputs
            for (i, c) in t.commitments.iter().enumerate() {
                outputs.push(serde_json::json!({
                    "type": "commitment",
                    "commitment": c,
                    "leafIndex": t.leaf_indices.get(i),
                }));
            }

            // Per-output unshield/withdraw from JSON array
            if let Some(ref uo) = t.unshield_outputs {
                for o in uo {
                    outputs.push(o.clone());
                }
            } else if let Some(amt) = t.unshield_amount {
                if t.transfer_type == "unshield" || t.transfer_type == "redeem" {
                    outputs.push(serde_json::json!({
                        "type": if t.transfer_type == "redeem" { "withdraw" } else { "unshield" },
                        "amount": amt,
                        "fee": t.unshield_fee,
                        "payout": t.unshield_payout,
                        "recipient": t.unshield_recipient,
                    }));
                }
            }

            let tx_type = match t.transfer_type.as_str() {
                "redeem" => "withdraw",
                "unshield" => "unshield",
                _ => "transfer",
            };

            transactions.push(serde_json::json!({
                "txSignature": t.tx_signature,
                "type": tx_type,
                "tokenId": t.token_id,
                "timestamp": t.timestamp,
                "status": t.status,
                "inputs": t.nullifier_hashes.iter().enumerate().map(|(i, h)| {
                    serde_json::json!({
                        "nullifierHash": h,
                        "nullifierPda": nullifier_pdas.get(i),
                    })
                }).collect::<Vec<_>>(),
                "outputs": outputs,
            }));
        }
    }

    // 3. Include pending BTC deposits from tracker (not yet on-chain)
    if let Some(ref deposit_store) = state.deposit_store {
        if let Ok(deposits) = deposit_store.get_all() {
            // Collect on-chain btc txids to avoid duplicates
            let on_chain_btc_txids: std::collections::HashSet<String> = transactions.iter()
                .filter_map(|t| t["inputs"][0]["btcDepositTxid"].as_str().map(|s| s.to_string()))
                .collect();

            use crate::deposit_tracker::DepositStatus;

            for dep in &deposits {
                // Skip if already represented on-chain
                if let Some(ref txid) = dep.deposit_txid {
                    if on_chain_btc_txids.contains(txid) {
                        continue;
                    }
                }
                // Skip completed deposits (already in announcements above)
                if matches!(dep.status, DepositStatus::Claimed | DepositStatus::Ready) {
                    continue;
                }

                let status_str = match dep.status {
                    DepositStatus::Detected | DepositStatus::Pending => "detected",
                    DepositStatus::Confirming => "confirming",
                    DepositStatus::Confirmed | DepositStatus::Sweeping | DepositStatus::SweepConfirming => "sweeping",
                    DepositStatus::Verifying => "processing",
                    DepositStatus::Failed => "failed",
                    _ => "pending",
                };

                transactions.push(serde_json::json!({
                    "txSignature": serde_json::Value::Null,
                    "type": "shield",
                    "tokenId": serde_json::Value::Null,
                    "timestamp": dep.updated_at,
                    "status": status_str,
                    "inputs": [{
                        "grossAmount": dep.amount_sats,
                        "fee": serde_json::Value::Null,
                        "netAmount": serde_json::Value::Null,
                        "btcDepositTxid": dep.deposit_txid,
                    }],
                    "outputs": [],
                    "btcMeta": {
                        "depositTxid": dep.deposit_txid,
                        "confirmations": dep.confirmations,
                        "sweepTxid": dep.sweep_txid,
                        "sweepConfirmations": dep.sweep_confirmations,
                        "taprootAddress": dep.taproot_address,
                    },
                }));
            }
        }
    }

    // Sort by timestamp desc
    transactions.sort_by(|a, b| {
        let ta = a["timestamp"].as_i64().unwrap_or(0);
        let tb = b["timestamp"].as_i64().unwrap_or(0);
        tb.cmp(&ta)
    });

    let count = transactions.len();
    Json(serde_json::json!({
        "success": true,
        "transactions": transactions,
        "count": count,
    }))
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

/// GET /api/redemption/completed — completed redemptions from on-chain events (no backend dependency)
async fn get_completed_redemptions(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    match state.store.get_completed_redemptions() {
        Ok(rows) => {
            let count = rows.len();
            Json(serde_json::json!({
                "success": true,
                "redemptions": rows,
                "count": count,
            }))
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to query completed redemptions");
            Json(serde_json::json!({
                "success": false,
                "redemptions": [],
                "count": 0,
                "error": e,
            }))
        }
    }
}

/// GET /api/redemption/requested — requested redemptions from on-chain events (0x08)
async fn get_requested_redemptions(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    match state.store.get_requested_redemptions() {
        Ok(rows) => {
            let count = rows.len();
            Json(serde_json::json!({
                "success": true,
                "redemptions": rows,
                "count": count,
            }))
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to query requested redemptions");
            Json(serde_json::json!({
                "success": false,
                "redemptions": [],
                "count": 0,
                "error": e,
            }))
        }
    }
}

/// GET /api/redemption/processing — processing redemptions from on-chain events (0x0A)
async fn get_processing_redemptions(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    match state.store.get_processing_redemptions() {
        Ok(rows) => {
            let count = rows.len();
            Json(serde_json::json!({
                "success": true,
                "redemptions": rows,
                "count": count,
            }))
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to query processing redemptions");
            Json(serde_json::json!({
                "success": false,
                "redemptions": [],
                "count": 0,
                "error": e,
            }))
        }
    }
}

/// GET /api/redemption/tracking — expose local redemption tracking state
///
/// Reads from the SQLite tracking database. Returns BTC txids, status,
/// timestamps, and errors keyed by PDA address for the frontend to join
/// with on-chain PDA data.
async fn get_redemption_tracking() -> Json<serde_json::Value> {
    use crate::redemption::tracking::TrackingStore;

    let db_path = "data/redemption_tracking.db";
    let store = TrackingStore::new(db_path);
    let entries = store.get_all().await;
    let count = entries.len();

    let tracking: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap_or_default())
        .collect();

    Json(serde_json::json!({
        "success": true,
        "tracking": tracking,
        "count": count,
    }))
}

/// GET /api/redemption/all — consolidated endpoint returning tracking + all event types
///
/// Combines tracking state, requested/processing/completed events in one response
/// so the frontend needs only a single backend fetch.
async fn get_all_redemptions(
    State(state): State<IndexerAppState>,
) -> Json<serde_json::Value> {
    use crate::redemption::tracking::TrackingStore;

    // Tracking from SQLite
    let store = TrackingStore::new("data/redemption_tracking.db");
    let tracking_entries = store.get_all().await;
    let tracking: Vec<serde_json::Value> = tracking_entries
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap_or_default())
        .collect();

    // Requested events
    let requested = state.store.get_requested_redemptions()
        .unwrap_or_default();

    // Processing events
    let processing = state.store.get_processing_redemptions()
        .unwrap_or_default();

    // Completed events
    let completed = state.store.get_completed_redemptions()
        .unwrap_or_default();

    Json(serde_json::json!({
        "success": true,
        "tracking": tracking,
        "requested": requested,
        "processing": processing,
        "completed": completed,
    }))
}
