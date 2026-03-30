//! SQLite-backed persistent state store for redemption tracking.
//!
//! Maps PDA addresses to redemption state with disk persistence for crash recovery.
//! Uses connection pooling via r2d2 for concurrent access.

use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use std::path::Path;

use super::types::{LocalRedemptionStatus, RedemptionTracking};

/// SQLite-backed tracking store with connection pooling.
pub struct TrackingStore {
    pool: Pool<SqliteConnectionManager>,
}

impl TrackingStore {
    /// Create a new tracking store backed by SQLite at the given path.
    ///
    /// Creates the database file and runs migrations if needed.
    /// If a legacy JSON file exists at the same base path, migrates its data.
    pub fn new(db_path: impl AsRef<Path>) -> Self {
        let db_path = db_path.as_ref();

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("[tracking] Failed to create directory {:?}: {}", parent, e);
            }
        }

        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(5)
            .build(manager)
            .unwrap_or_else(|e| panic!("[tracking] DB pool creation failed for {:?}: {}", db_path, e));

        let store = Self { pool };
        store.run_migrations();

        // Migrate legacy JSON if it exists
        store.migrate_from_json(db_path);

        store
    }

    /// Create an in-memory store (for testing).
    pub fn in_memory() -> Self {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder()
            .max_size(1)
            .build(manager)
            .expect("Failed to create in-memory tracking DB pool");

        let store = Self { pool };
        store.run_migrations();
        store
    }

    fn conn(&self) -> PooledConnection<SqliteConnectionManager> {
        self.pool.get().unwrap_or_else(|e| {
            eprintln!("[tracking] DB pool exhausted (max_size=5): {}. Retrying in 100ms...", e);
            std::thread::sleep(std::time::Duration::from_millis(100));
            self.pool.get().unwrap_or_else(|e2| {
                panic!("[tracking] DB pool exhausted after retry: {}", e2)
            })
        })
    }

    fn run_migrations(&self) {
        let conn = self.conn();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS redemption_tracking (
                pda_address TEXT PRIMARY KEY,
                request_id INTEGER,
                requester TEXT,
                amount_sats INTEGER,
                btc_script TEXT,
                btc_txid TEXT,
                local_status TEXT NOT NULL DEFAULT 'Detected',
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_updated INTEGER NOT NULL,
                error TEXT,
                verified_tx_pda TEXT,
                buffer_pubkey TEXT,
                tx_size INTEGER,
                simulated INTEGER NOT NULL DEFAULT 0,
                consumed_utxo_pdas TEXT,
                pool_script_hex TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_request_id
                ON redemption_tracking(request_id) WHERE request_id IS NOT NULL;
            "#,
        )
        .expect("Failed to run tracking migrations");
    }

    /// Migrate data from legacy `redemption_tracking.json` file if it exists.
    fn migrate_from_json(&self, db_path: &Path) {
        // Look for JSON file next to the DB (or at the old default path)
        let json_path = db_path.with_extension("json");
        let legacy_path = std::path::PathBuf::from("redemption_tracking.json");

        let path = if json_path.exists() {
            json_path
        } else if legacy_path.exists() {
            legacy_path
        } else {
            return;
        };

        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(_) => return,
        };

        let entries: Vec<RedemptionTracking> = match serde_json::from_str(&data) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("Failed to parse legacy tracking JSON for migration: {}", e);
                return;
            }
        };

        if entries.is_empty() {
            // Remove empty JSON file
            std::fs::remove_file(&path).ok();
            return;
        }

        let mut migrated = 0;
        for entry in &entries {
            if self.upsert_sync(entry).is_ok() {
                migrated += 1;
            }
        }

        tracing::info!(
            "Migrated {} tracking entries from JSON to SQLite",
            migrated
        );

        // Rename legacy file so we don't re-migrate
        let backup = path.with_extension("json.migrated");
        std::fs::rename(&path, &backup).ok();
    }

    // ── Sync CRUD (used internally and by migration) ──

    fn upsert_sync(&self, entry: &RedemptionTracking) -> Result<(), rusqlite::Error> {
        let conn = self.conn();
        let consumed = serde_json::to_string(&entry.consumed_utxo_pdas).unwrap_or_default();
        let status_str = status_to_str(entry.local_status);

        conn.execute(
            r#"
            INSERT INTO redemption_tracking (
                pda_address, request_id, requester, amount_sats, btc_script,
                btc_txid, local_status, retry_count, created_at, last_updated,
                error, verified_tx_pda, buffer_pubkey, tx_size, simulated,
                consumed_utxo_pdas, pool_script_hex
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            ON CONFLICT(pda_address) DO UPDATE SET
                request_id = excluded.request_id,
                requester = excluded.requester,
                amount_sats = excluded.amount_sats,
                btc_script = excluded.btc_script,
                btc_txid = excluded.btc_txid,
                local_status = excluded.local_status,
                retry_count = excluded.retry_count,
                last_updated = excluded.last_updated,
                error = excluded.error,
                verified_tx_pda = excluded.verified_tx_pda,
                buffer_pubkey = excluded.buffer_pubkey,
                tx_size = excluded.tx_size,
                simulated = excluded.simulated,
                consumed_utxo_pdas = excluded.consumed_utxo_pdas,
                pool_script_hex = excluded.pool_script_hex
            "#,
            params![
                entry.pda_address,
                entry.request_id,
                entry.requester,
                entry.amount_sats.map(|v| v as i64),
                entry.btc_script,
                entry.btc_txid,
                status_str,
                entry.retry_count,
                entry.created_at as i64,
                entry.last_updated as i64,
                entry.error,
                entry.verified_tx_pda,
                entry.buffer_pubkey,
                entry.tx_size,
                entry.simulated as i32,
                consumed,
                entry.pool_script_hex,
            ],
        )?;
        Ok(())
    }

    fn get_by_pda_sync(&self, pda_address: &str) -> Option<RedemptionTracking> {
        let conn = self.conn();
        conn.query_row(
            "SELECT * FROM redemption_tracking WHERE pda_address = ?1",
            params![pda_address],
            row_to_tracking,
        )
        .optional()
        .ok()
        .flatten()
    }

    fn remove_sync(&self, pda_address: &str) {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM redemption_tracking WHERE pda_address = ?1",
            params![pda_address],
        )
        .ok();
    }

    fn list_all_sync(&self) -> Vec<RedemptionTracking> {
        let conn = self.conn();
        let mut stmt = match conn.prepare("SELECT * FROM redemption_tracking ORDER BY last_updated DESC") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], row_to_tracking)
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    // ── Public async API (same signatures as old JSON store) ──

    /// Check if a PDA address is already tracked.
    pub async fn contains(&self, pda_address: &str) -> bool {
        self.get_by_pda_sync(pda_address).is_some()
    }

    /// Get a tracking entry by PDA address.
    pub async fn get(&self, pda_address: &str) -> Option<RedemptionTracking> {
        self.get_by_pda_sync(pda_address)
    }

    /// Get a tracking entry by request_id.
    pub async fn get_by_request_id(&self, request_id: u64) -> Option<RedemptionTracking> {
        let conn = self.conn();
        conn.query_row(
            "SELECT * FROM redemption_tracking WHERE request_id = ?1",
            params![request_id as i64],
            row_to_tracking,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Insert or update a tracking entry.
    pub async fn upsert(&self, entry: RedemptionTracking) {
        if let Err(e) = self.upsert_sync(&entry) {
            tracing::error!("Failed to upsert tracking entry {}: {}", entry.pda_address, e);
        }
    }

    /// Remove a tracking entry by PDA address.
    pub async fn remove(&self, pda_address: &str) {
        self.remove_sync(pda_address);
    }

    /// Get all entries matching a given status.
    pub async fn get_by_status(&self, status: LocalRedemptionStatus) -> Vec<RedemptionTracking> {
        let conn = self.conn();
        let status_str = status_to_str(status);
        let mut stmt = match conn.prepare(
            "SELECT * FROM redemption_tracking WHERE local_status = ?1 ORDER BY last_updated DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![status_str], row_to_tracking)
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// Get all tracked entries.
    pub async fn get_all(&self) -> Vec<RedemptionTracking> {
        self.list_all_sync()
    }

    /// Remove entries whose PDAs no longer exist on-chain.
    pub async fn reconcile(&self, active_pda_addresses: &[String]) {
        if active_pda_addresses.is_empty() {
            return;
        }

        let all = self.list_all_sync();
        let active_set: std::collections::HashSet<&str> =
            active_pda_addresses.iter().map(|s| s.as_str()).collect();

        for entry in &all {
            if !active_set.contains(entry.pda_address.as_str()) {
                self.remove_sync(&entry.pda_address);
            }
        }
    }
}

// ── Helpers ──

fn status_to_str(status: LocalRedemptionStatus) -> &'static str {
    match status {
        LocalRedemptionStatus::Detected => "Detected",
        LocalRedemptionStatus::Signing => "Signing",
        LocalRedemptionStatus::AwaitingConfirmation => "AwaitingConfirmation",
        LocalRedemptionStatus::SpvVerified => "SpvVerified",
        LocalRedemptionStatus::Completed => "Completed",
        LocalRedemptionStatus::Failed => "Failed",
    }
}

fn str_to_status(s: &str) -> LocalRedemptionStatus {
    match s {
        "Signing" => LocalRedemptionStatus::Signing,
        "AwaitingConfirmation" => LocalRedemptionStatus::AwaitingConfirmation,
        "SpvVerified" => LocalRedemptionStatus::SpvVerified,
        "Completed" => LocalRedemptionStatus::Completed,
        "Failed" => LocalRedemptionStatus::Failed,
        _ => LocalRedemptionStatus::Detected,
    }
}

fn row_to_tracking(row: &rusqlite::Row) -> Result<RedemptionTracking, rusqlite::Error> {
    let status_str: String = row.get("local_status")?;
    let consumed_json: Option<String> = row.get("consumed_utxo_pdas")?;
    let consumed: Vec<String> = consumed_json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    let simulated_int: i32 = row.get("simulated")?;
    let amount_sats: Option<i64> = row.get("amount_sats")?;

    Ok(RedemptionTracking {
        pda_address: row.get("pda_address")?,
        btc_txid: row.get("btc_txid")?,
        local_status: str_to_status(&status_str),
        retry_count: row.get::<_, i32>("retry_count")? as u32,
        created_at: row.get::<_, i64>("created_at")? as u64,
        last_updated: row.get::<_, i64>("last_updated")? as u64,
        error: row.get("error")?,
        verified_tx_pda: row.get("verified_tx_pda")?,
        buffer_pubkey: row.get("buffer_pubkey")?,
        tx_size: row.get::<_, Option<i32>>("tx_size")?.map(|v| v as u32),
        requester: row.get("requester")?,
        amount_sats: amount_sats.map(|v| v as u64),
        btc_script: row.get("btc_script")?,
        request_id: row.get::<_, Option<i64>>("request_id")?.map(|v| v as u64),
        simulated: simulated_int != 0,
        consumed_utxo_pdas: consumed,
        pool_script_hex: row.get("pool_script_hex")?,
    })
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(pda: &str, status: LocalRedemptionStatus) -> RedemptionTracking {
        RedemptionTracking {
            pda_address: pda.to_string(),
            btc_txid: None,
            local_status: status,
            retry_count: 0,
            created_at: 1000,
            last_updated: 1000,
            error: None,
            verified_tx_pda: None,
            buffer_pubkey: None,
            tx_size: None,
            requester: Some("requester1".to_string()),
            amount_sats: Some(50_000),
            btc_script: Some("0014abcd".to_string()),
            request_id: Some(1),
            simulated: false,
            consumed_utxo_pdas: vec![],
            pool_script_hex: None,
        }
    }

    #[tokio::test]
    async fn test_insert_and_get() {
        let store = TrackingStore::in_memory();
        let entry = make_entry("pda_1", LocalRedemptionStatus::Detected);
        store.upsert(entry.clone()).await;

        let got = store.get("pda_1").await.unwrap();
        assert_eq!(got.pda_address, "pda_1");
        assert_eq!(got.amount_sats, Some(50_000));
        assert_eq!(got.request_id, Some(1));
    }

    #[tokio::test]
    async fn test_upsert_updates_existing() {
        let store = TrackingStore::in_memory();
        let mut entry = make_entry("pda_1", LocalRedemptionStatus::Detected);
        store.upsert(entry.clone()).await;

        entry.local_status = LocalRedemptionStatus::Signing;
        entry.last_updated = 2000;
        entry.btc_txid = Some("txid_abc".to_string());
        store.upsert(entry).await;

        let got = store.get("pda_1").await.unwrap();
        assert_eq!(got.local_status, LocalRedemptionStatus::Signing);
        assert_eq!(got.btc_txid, Some("txid_abc".to_string()));
        assert_eq!(got.last_updated, 2000);
    }

    #[tokio::test]
    async fn test_get_by_request_id() {
        let store = TrackingStore::in_memory();
        let mut entry = make_entry("pda_1", LocalRedemptionStatus::Detected);
        entry.request_id = Some(42);
        store.upsert(entry).await;

        let got = store.get_by_request_id(42).await.unwrap();
        assert_eq!(got.pda_address, "pda_1");

        assert!(store.get_by_request_id(999).await.is_none());
    }

    #[tokio::test]
    async fn test_reconcile_removes_stale() {
        let store = TrackingStore::in_memory();
        store.upsert(make_entry("pda_1", LocalRedemptionStatus::Detected)).await;
        store.upsert(make_entry("pda_2", LocalRedemptionStatus::Signing)).await;
        store.upsert(make_entry("pda_3", LocalRedemptionStatus::Completed)).await;

        // Only pda_1 is still active on-chain
        store.reconcile(&["pda_1".to_string()]).await;

        assert!(store.get("pda_1").await.is_some());
        assert!(store.get("pda_2").await.is_none());
        assert!(store.get("pda_3").await.is_none());
    }

    #[tokio::test]
    async fn test_concurrent_insert_same_pda() {
        let store = TrackingStore::in_memory();
        let entry1 = make_entry("pda_1", LocalRedemptionStatus::Detected);
        let mut entry2 = make_entry("pda_1", LocalRedemptionStatus::Signing);
        entry2.last_updated = 2000;

        store.upsert(entry1).await;
        store.upsert(entry2).await; // should upsert, not error

        let got = store.get("pda_1").await.unwrap();
        assert_eq!(got.local_status, LocalRedemptionStatus::Signing);
    }

    #[tokio::test]
    async fn test_list_all() {
        let store = TrackingStore::in_memory();
        store.upsert(make_entry("pda_1", LocalRedemptionStatus::Detected)).await;

        let mut entry2 = make_entry("pda_2", LocalRedemptionStatus::Signing);
        entry2.request_id = Some(2);
        store.upsert(entry2).await;

        let all = store.get_all().await;
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_get_by_status() {
        let store = TrackingStore::in_memory();
        store.upsert(make_entry("pda_1", LocalRedemptionStatus::Detected)).await;

        let mut entry2 = make_entry("pda_2", LocalRedemptionStatus::Signing);
        entry2.request_id = Some(2);
        store.upsert(entry2).await;

        let mut entry3 = make_entry("pda_3", LocalRedemptionStatus::Detected);
        entry3.request_id = Some(3);
        store.upsert(entry3).await;

        let detected = store.get_by_status(LocalRedemptionStatus::Detected).await;
        assert_eq!(detected.len(), 2);

        let signing = store.get_by_status(LocalRedemptionStatus::Signing).await;
        assert_eq!(signing.len(), 1);
    }

    #[tokio::test]
    async fn test_remove() {
        let store = TrackingStore::in_memory();
        store.upsert(make_entry("pda_1", LocalRedemptionStatus::Detected)).await;
        assert!(store.contains("pda_1").await);

        store.remove("pda_1").await;
        assert!(!store.contains("pda_1").await);
    }

    #[tokio::test]
    async fn test_consumed_utxo_pdas_roundtrip() {
        let store = TrackingStore::in_memory();
        let mut entry = make_entry("pda_1", LocalRedemptionStatus::Detected);
        entry.consumed_utxo_pdas = vec!["utxo1".to_string(), "utxo2".to_string()];
        store.upsert(entry).await;

        let got = store.get("pda_1").await.unwrap();
        assert_eq!(got.consumed_utxo_pdas, vec!["utxo1", "utxo2"]);
    }
}
