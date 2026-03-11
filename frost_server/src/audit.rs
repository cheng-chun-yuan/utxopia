//! Audit logging for FROST signing operations
//!
//! Append-only JSON-lines log file recording every policy decision
//! and signing event for forensic review.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

/// Audit logger that writes JSON-lines to a file
pub struct AuditLog {
    path: PathBuf,
    writer: Mutex<Option<std::fs::File>>,
}

/// A single audit log entry
#[derive(Debug, Serialize, Deserialize)]
pub struct AuditEntry {
    /// ISO-8601 timestamp
    pub ts: String,
    /// Session ID
    pub session_id: String,
    /// Action type (e.g., "policy_check", "round1", "round2", "signing_complete")
    pub action: String,
    /// Sighash (hex, truncated to 16 chars for readability)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sighash: Option<String>,
    /// Result ("allow", "deny", "ok", "error")
    pub result: String,
    /// Reason for deny, or error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Destinations in the transaction
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destinations: Option<Vec<String>>,
    /// Total amount in sats
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_sats: Option<u64>,
    /// Fee in sats
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_sats: Option<u64>,
    /// Signer ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signer_id: Option<u16>,
    /// Requester pubkey (base58) for duplicate tracking
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requester: Option<String>,
    /// Redemption nonce for duplicate tracking
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redemption_nonce: Option<u64>,
}

impl AuditLog {
    /// Create a new audit logger
    ///
    /// If `path` is None, logging is disabled (no-op).
    pub fn new(path: Option<PathBuf>) -> Self {
        let writer = path.as_ref().and_then(|p| {
            // Ensure parent directory exists
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .ok()
        });

        Self {
            path: path.unwrap_or_default(),
            writer: Mutex::new(writer),
        }
    }

    /// Log an audit entry
    pub fn log(&self, entry: &AuditEntry) {
        let mut guard = match self.writer.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        if let Some(ref mut file) = *guard {
            if let Ok(json) = serde_json::to_string(entry) {
                let _ = writeln!(file, "{}", json);
                let _ = file.flush();
            }
        }
    }

    /// Log a policy decision
    pub fn log_policy(
        &self,
        session_id: &str,
        sighash: &str,
        result: &str,
        reason: Option<&str>,
        destinations: Option<Vec<String>>,
        amount_sats: Option<u64>,
        fee_sats: Option<u64>,
    ) {
        self.log(&AuditEntry {
            ts: chrono_now(),
            session_id: session_id.to_string(),
            action: "policy_check".to_string(),
            sighash: Some(sighash.chars().take(16).collect()),
            result: result.to_string(),
            reason: reason.map(|s| s.to_string()),
            destinations,
            amount_sats,
            fee_sats,
            signer_id: None,
            requester: None,
            redemption_nonce: None,
        });
    }

    /// Log a signing event (round1, round2)
    pub fn log_signing(
        &self,
        session_id: &str,
        action: &str,
        signer_id: u16,
        result: &str,
        reason: Option<&str>,
    ) {
        self.log(&AuditEntry {
            ts: chrono_now(),
            session_id: session_id.to_string(),
            action: action.to_string(),
            sighash: None,
            result: result.to_string(),
            reason: reason.map(|s| s.to_string()),
            destinations: None,
            amount_sats: None,
            fee_sats: None,
            signer_id: Some(signer_id),
            requester: None,
            redemption_nonce: None,
        });
    }

    /// Log a signing completion event (for duplicate tracking)
    pub fn log_signing_complete(
        &self,
        session_id: &str,
        signer_id: u16,
        requester: &str,
        nonce: u64,
    ) {
        self.log(&AuditEntry {
            ts: chrono_now(),
            session_id: session_id.to_string(),
            action: "signing_complete".to_string(),
            sighash: None,
            result: "ok".to_string(),
            reason: None,
            destinations: None,
            amount_sats: None,
            fee_sats: None,
            signer_id: Some(signer_id),
            requester: Some(requester.to_string()),
            redemption_nonce: Some(nonce),
        });
    }

    /// Scan the audit log on startup to rebuild the set of already-signed (requester, nonce) pairs.
    /// Returns a HashSet of `"requester:nonce"` strings.
    pub fn scan_signed_redemptions(&self) -> HashSet<String> {
        let mut signed = HashSet::new();

        if self.path.as_os_str().is_empty() {
            return signed;
        }

        let file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return signed,
        };

        let reader = BufReader::new(file);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if let Ok(entry) = serde_json::from_str::<AuditEntry>(&line) {
                if entry.action == "signing_complete" && entry.result == "ok" {
                    if let (Some(req), Some(nonce)) = (entry.requester, entry.redemption_nonce) {
                        signed.insert(format!("{}:{}", req, nonce));
                    }
                }
            }
        }

        tracing::info!(
            count = signed.len(),
            path = %self.path.display(),
            "loaded previously signed redemptions from audit log"
        );

        signed
    }

    /// Get the log file path (for diagnostics)
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

/// Current time as ISO-8601 string (UTC)
fn chrono_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    // Simple UTC format without chrono dependency
    let secs = now.as_secs();
    let days = secs / 86400;
    let rem = secs % 86400;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let seconds = rem % 60;

    // Days since epoch to Y-M-D (simplified)
    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch to (year, month, day)
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Civil calendar algorithm
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audit_log_disabled() {
        let log = AuditLog::new(None);
        // Should not panic
        log.log_policy("sess1", "aabb", "allow", None, None, None, None);
        log.log_signing("sess1", "round1", 1, "ok", None);
    }

    #[test]
    fn test_audit_log_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let log = AuditLog::new(Some(path.clone()));

        log.log_policy(
            "sess1",
            "aabbccdd",
            "allow",
            None,
            Some(vec!["tb1p...".to_string()]),
            Some(10000),
            Some(200),
        );
        log.log_signing("sess1", "round1", 1, "ok", None);

        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("policy_check"));
        assert!(lines[1].contains("round1"));
    }
}
