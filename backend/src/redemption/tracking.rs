//! Persistent local state store for redemption tracking.
//!
//! Maps PDA addresses to BTC txids with disk persistence for crash recovery.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{LocalRedemptionStatus, RedemptionTracking};

/// Persistent tracking store that maps PDA addresses to redemption state.
///
/// All mutations are persisted to disk atomically for crash recovery.
pub struct TrackingStore {
    entries: Arc<RwLock<HashMap<String, RedemptionTracking>>>,
    file_path: PathBuf,
}

impl TrackingStore {
    /// Create a new tracking store, loading existing state from disk if available.
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        let file_path = file_path.into();
        let entries = Self::load_from_disk(&file_path).unwrap_or_default();
        Self {
            entries: Arc::new(RwLock::new(entries)),
            file_path,
        }
    }

    /// Check if a PDA address is already tracked.
    pub async fn contains(&self, pda_address: &str) -> bool {
        let entries = self.entries.read().await;
        entries.contains_key(pda_address)
    }

    /// Get a tracking entry by PDA address.
    pub async fn get(&self, pda_address: &str) -> Option<RedemptionTracking> {
        let entries = self.entries.read().await;
        entries.get(pda_address).cloned()
    }

    /// Insert or update a tracking entry and persist to disk.
    pub async fn upsert(&self, entry: RedemptionTracking) {
        let mut entries = self.entries.write().await;
        entries.insert(entry.pda_address.clone(), entry);
        self.persist(&entries);
    }

    /// Remove a tracking entry by PDA address and persist to disk.
    pub async fn remove(&self, pda_address: &str) {
        let mut entries = self.entries.write().await;
        entries.remove(pda_address);
        self.persist(&entries);
    }

    /// Get all entries matching a given status.
    pub async fn get_by_status(&self, status: LocalRedemptionStatus) -> Vec<RedemptionTracking> {
        let entries = self.entries.read().await;
        entries
            .values()
            .filter(|e| e.local_status == status)
            .cloned()
            .collect()
    }

    /// Get all tracked entries.
    pub async fn get_all(&self) -> Vec<RedemptionTracking> {
        let entries = self.entries.read().await;
        entries.values().cloned().collect()
    }

    /// Remove entries whose PDAs no longer exist on-chain.
    ///
    /// Any tracked PDA not in `active_pda_addresses` is removed.
    pub async fn reconcile(&self, active_pda_addresses: &[String]) {
        let mut entries = self.entries.write().await;
        let active_set: std::collections::HashSet<&str> =
            active_pda_addresses.iter().map(|s| s.as_str()).collect();
        entries.retain(|pda, _| active_set.contains(pda.as_str()));
        self.persist(&entries);
    }

    /// Load entries from a JSON file on disk.
    fn load_from_disk(path: &PathBuf) -> Option<HashMap<String, RedemptionTracking>> {
        let data = std::fs::read_to_string(path).ok()?;
        let entries: Vec<RedemptionTracking> = serde_json::from_str(&data).ok()?;
        let map = entries
            .into_iter()
            .map(|e| (e.pda_address.clone(), e))
            .collect();
        Some(map)
    }

    /// Atomically persist current state to disk.
    ///
    /// Writes to a temporary file first, sets permissions (0600 on Unix),
    /// then renames to the final path.
    fn persist(&self, entries: &HashMap<String, RedemptionTracking>) {
        let vec: Vec<&RedemptionTracking> = entries.values().collect();
        let json = match serde_json::to_string_pretty(&vec) {
            Ok(j) => j,
            Err(e) => {
                tracing::error!("Failed to serialize tracking state: {}", e);
                return;
            }
        };

        let tmp_path = self.file_path.with_extension("json.tmp");

        if let Err(e) = std::fs::write(&tmp_path, &json) {
            tracing::error!("Failed to write tracking tmp file: {}", e);
            return;
        }

        // Set restrictive permissions on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            if let Err(e) = std::fs::set_permissions(&tmp_path, perms) {
                tracing::error!("Failed to set permissions on tracking tmp file: {}", e);
            }
        }

        if let Err(e) = std::fs::rename(&tmp_path, &self.file_path) {
            tracing::error!("Failed to rename tracking tmp file: {}", e);
        }
    }
}
