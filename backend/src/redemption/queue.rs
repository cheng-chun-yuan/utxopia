//! Withdrawal Queue
//!
//! Manages pending withdrawal requests.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::redemption::types::{WithdrawalRequest, WithdrawalStatus};

/// Queue for managing withdrawal requests
pub struct WithdrawalQueue {
    /// Requests by ID
    requests: Arc<RwLock<HashMap<String, WithdrawalRequest>>>,
    /// Maximum queue size
    max_size: usize,
}

impl WithdrawalQueue {
    /// Create a new withdrawal queue
    pub fn new(max_size: usize) -> Self {
        Self {
            requests: Arc::new(RwLock::new(HashMap::new())),
            max_size,
        }
    }

    /// Add a new withdrawal request
    pub async fn add(&self, request: WithdrawalRequest) -> Result<String, QueueError> {
        let mut requests = self.requests.write().await;

        if requests.len() >= self.max_size {
            return Err(QueueError::QueueFull);
        }

        let id = request.id.clone();
        requests.insert(id.clone(), request);
        Ok(id)
    }

    /// Get a request by ID
    pub async fn get(&self, id: &str) -> Option<WithdrawalRequest> {
        self.requests.read().await.get(id).cloned()
    }

    /// Update a request
    pub async fn update(&self, request: WithdrawalRequest) -> Result<(), QueueError> {
        let mut requests = self.requests.write().await;

        if !requests.contains_key(&request.id) {
            return Err(QueueError::NotFound(request.id.clone()));
        }

        requests.insert(request.id.clone(), request);
        Ok(())
    }

    /// Get all pending requests
    pub async fn get_pending(&self) -> Vec<WithdrawalRequest> {
        self.requests
            .read()
            .await
            .values()
            .filter(|r| r.status == WithdrawalStatus::Pending)
            .cloned()
            .collect()
    }

    /// Get all requests by status
    pub async fn get_by_status(&self, status: WithdrawalStatus) -> Vec<WithdrawalRequest> {
        self.requests
            .read()
            .await
            .values()
            .filter(|r| r.status == status)
            .cloned()
            .collect()
    }

    /// Get all active (non-complete, non-failed) requests
    pub async fn get_active(&self) -> Vec<WithdrawalRequest> {
        self.requests
            .read()
            .await
            .values()
            .filter(|r| {
                r.status != WithdrawalStatus::Complete && r.status != WithdrawalStatus::Failed
            })
            .cloned()
            .collect()
    }

    /// Get all requests
    pub async fn get_all(&self) -> Vec<WithdrawalRequest> {
        self.requests.read().await.values().cloned().collect()
    }

    /// Remove a request
    pub async fn remove(&self, id: &str) -> Option<WithdrawalRequest> {
        self.requests.write().await.remove(id)
    }

    /// Get queue length
    pub async fn len(&self) -> usize {
        self.requests.read().await.len()
    }

    /// Check if queue is empty
    pub async fn is_empty(&self) -> bool {
        self.requests.read().await.is_empty()
    }

    /// Clear all requests
    pub async fn clear(&self) {
        self.requests.write().await.clear();
    }

    /// Get statistics
    pub async fn stats(&self) -> QueueStats {
        let requests = self.requests.read().await;

        QueueStats {
            total: requests.len(),
            pending: requests.values().filter(|r| r.status == WithdrawalStatus::Pending).count(),
            building: requests.values().filter(|r| r.status == WithdrawalStatus::Building).count(),
            signing: requests.values().filter(|r| r.status == WithdrawalStatus::Signing).count(),
            broadcasting: requests.values().filter(|r| r.status == WithdrawalStatus::Broadcasting).count(),
            confirming: requests.values().filter(|r| r.status == WithdrawalStatus::Confirming).count(),
            complete: requests.values().filter(|r| r.status == WithdrawalStatus::Complete).count(),
            failed: requests.values().filter(|r| r.status == WithdrawalStatus::Failed).count(),
        }
    }
}

impl Default for WithdrawalQueue {
    fn default() -> Self {
        Self::new(1000)
    }
}

/// Queue statistics
#[derive(Debug, Clone, Default)]
pub struct QueueStats {
    pub total: usize,
    pub pending: usize,
    pub building: usize,
    pub signing: usize,
    pub broadcasting: usize,
    pub confirming: usize,
    pub complete: usize,
    pub failed: usize,
}

impl std::fmt::Display for QueueStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Queue: {} total | pending: {} | building: {} | signing: {} | confirming: {} | complete: {} | failed: {}",
            self.total, self.pending, self.building, self.signing, self.confirming, self.complete, self.failed
        )
    }
}

/// Queue errors
#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error("queue is full")]
    QueueFull,

    #[error("request not found: {0}")]
    NotFound(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_queue_operations() {
        let queue = WithdrawalQueue::new(10);

        // Add request
        let request = WithdrawalRequest::new(
            "sol_tx_123".to_string(),
            "user_pubkey".to_string(),
            100_000,
            "tb1qtest...".to_string(),
        );
        let id = request.id.clone();

        queue.add(request).await.unwrap();
        assert_eq!(queue.len().await, 1);

        // Get request
        let retrieved = queue.get(&id).await.unwrap();
        assert_eq!(retrieved.amount_sats, 100_000);

        // Get pending
        let pending = queue.get_pending().await;
        assert_eq!(pending.len(), 1);

        // Update status
        let mut updated = retrieved;
        updated.mark_building();
        queue.update(updated).await.unwrap();

        let pending = queue.get_pending().await;
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn test_queue_full() {
        let queue = WithdrawalQueue::new(1);

        let request1 = WithdrawalRequest::new(
            "tx1".to_string(),
            "user1".to_string(),
            100_000,
            "addr1".to_string(),
        );
        queue.add(request1).await.unwrap();

        let request2 = WithdrawalRequest::new(
            "tx2".to_string(),
            "user2".to_string(),
            200_000,
            "addr2".to_string(),
        );

        assert!(matches!(queue.add(request2).await, Err(QueueError::QueueFull)));
    }
}
