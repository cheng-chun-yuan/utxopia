//! Cached Merkle tree backed by EventStore
//!
//! Wraps `MerkleTree` with `RwLock` for concurrent access.
//! On startup, loads all leaves from SQLite and builds the tree.
//! On new leaf insertion, updates the tree incrementally.

use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::merkle_tree::{MerkleProof, MerkleTree, TreeStatus};
use super::parser::StealthAnnouncementEvent;
use super::storage::EventStore;

/// Update broadcast when a leaf is inserted
#[derive(Debug, Clone, serde::Serialize)]
pub struct TreeUpdate {
    #[serde(rename = "type")]
    pub update_type: String,
    pub leaf_index: u64,
    pub commitment: String,
    pub new_root: String,
}

/// Update broadcast when a nullifier is spent
#[derive(Debug, Clone, serde::Serialize)]
pub struct NullifierUpdate {
    #[serde(rename = "type")]
    pub update_type: String,
    pub nullifier_hash: String,
    pub slot: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AnnouncementUpdate {
    #[serde(rename = "type")]
    pub update_type: String,
    pub announcement_type: u8,
    pub ephemeral_pub: String,
    pub encrypted_amount: String,
    pub commitment: String,
    pub leaf_index: u32,
}

/// Cached Merkle tree with read/write locking
pub struct TreeCache {
    tree: RwLock<MerkleTree>,
    store: Arc<EventStore>,
    /// Broadcast channel for tree update notifications
    update_tx: broadcast::Sender<TreeUpdate>,
    /// Broadcast channel for nullifier spent notifications
    nullifier_tx: broadcast::Sender<NullifierUpdate>,
    /// Broadcast channel for stealth announcement notifications
    announcement_tx: broadcast::Sender<AnnouncementUpdate>,
}

impl TreeCache {
    /// Create a new TreeCache, loading all existing leaves from the store
    pub fn new(store: Arc<EventStore>) -> Result<Self, String> {
        let leaves = store.get_leaves(None)?;

        let mut commitments: Vec<[u8; 32]> = Vec::with_capacity(leaves.len());
        for leaf in &leaves {
            let bytes = hex::decode(&leaf.commitment)
                .map_err(|e| format!("bad commitment hex: {}", e))?;
            if bytes.len() != 32 {
                return Err(format!("commitment wrong length: {}", bytes.len()));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            commitments.push(arr);
        }

        let tree = MerkleTree::build_from_leaves(&commitments)?;
        let (update_tx, _) = broadcast::channel(256);
        let (nullifier_tx, _) = broadcast::channel(256);
        let (announcement_tx, _) = broadcast::channel(256);

        tracing::info!(
            leaves = commitments.len(),
            root = %tree.root_hex(),
            "TreeCache initialized from store"
        );

        Ok(Self {
            tree: RwLock::new(tree),
            store,
            update_tx,
            nullifier_tx,
            announcement_tx,
        })
    }

    /// Called by the indexer service when a new leaf is indexed
    pub async fn on_leaf_inserted(&self, leaf_index: u64, commitment: [u8; 32]) {
        let mut tree = self.tree.write().await;

        // Verify sequential insertion
        if leaf_index != tree.size() {
            tracing::warn!(
                expected = tree.size(),
                got = leaf_index,
                "TreeCache: leaf_index mismatch, forcing rebuild"
            );
            drop(tree);
            if let Err(e) = self.force_rebuild().await {
                tracing::error!(error = %e, "Force rebuild failed");
            }
            return;
        }

        match tree.add_leaf(commitment) {
            Ok(_) => {
                let update = TreeUpdate {
                    update_type: "leaf_inserted".to_string(),
                    leaf_index,
                    commitment: hex::encode(commitment),
                    new_root: tree.root_hex(),
                };
                tracing::debug!(leaf_index, root = %tree.root_hex(), "TreeCache updated");
                // Broadcast (ignore if no subscribers)
                let _ = self.update_tx.send(update);
            }
            Err(e) => {
                tracing::error!(error = %e, "TreeCache: failed to add leaf");
            }
        }
    }

    /// Get Merkle proof for a commitment (hex string)
    pub async fn get_proof(&self, commitment_hex: &str) -> Option<MerkleProof> {
        let tree = self.tree.read().await;
        tree.get_proof(commitment_hex)
    }

    /// Get current root as hex
    pub async fn get_root_hex(&self) -> String {
        let tree = self.tree.read().await;
        tree.root_hex()
    }

    /// Get tree status
    pub async fn get_status(&self) -> TreeStatus {
        let tree = self.tree.read().await;
        tree.status()
    }

    /// Force rebuild from SQLite
    pub async fn force_rebuild(&self) -> Result<(), String> {
        let leaves = self.store.get_leaves(None)?;

        let mut commitments: Vec<[u8; 32]> = Vec::with_capacity(leaves.len());
        for leaf in &leaves {
            let bytes = hex::decode(&leaf.commitment)
                .map_err(|e| format!("bad commitment hex: {}", e))?;
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            commitments.push(arr);
        }

        let new_tree = MerkleTree::build_from_leaves(&commitments)?;

        tracing::info!(
            leaves = commitments.len(),
            root = %new_tree.root_hex(),
            "TreeCache rebuilt from store"
        );

        let mut tree = self.tree.write().await;
        *tree = new_tree;
        Ok(())
    }

    /// Subscribe to tree updates (for WebSocket broadcast)
    pub fn subscribe(&self) -> broadcast::Receiver<TreeUpdate> {
        self.update_tx.subscribe()
    }

    /// Broadcast a nullifier spent event to subscribers
    pub fn broadcast_nullifier(&self, nullifier_hash: &str, slot: i64) {
        let update = NullifierUpdate {
            update_type: "nullifier_spent".to_string(),
            nullifier_hash: nullifier_hash.to_string(),
            slot,
        };
        let _ = self.nullifier_tx.send(update);
    }

    /// Subscribe to nullifier updates (for WebSocket broadcast)
    pub fn subscribe_nullifiers(&self) -> broadcast::Receiver<NullifierUpdate> {
        self.nullifier_tx.subscribe()
    }

    /// Broadcast a stealth announcement event to subscribers
    pub fn broadcast_announcement(&self, event: &StealthAnnouncementEvent) {
        let update = AnnouncementUpdate {
            update_type: "stealth_announcement".to_string(),
            announcement_type: event.announcement_type,
            ephemeral_pub: hex::encode(event.ephemeral_pub),
            encrypted_amount: hex::encode(event.encrypted_amount),
            commitment: hex::encode(event.commitment),
            leaf_index: event.leaf_index,
        };
        let _ = self.announcement_tx.send(update);
    }

    /// Subscribe to stealth announcement updates (for WebSocket broadcast)
    pub fn subscribe_announcements(&self) -> broadcast::Receiver<AnnouncementUpdate> {
        self.announcement_tx.subscribe()
    }
}
