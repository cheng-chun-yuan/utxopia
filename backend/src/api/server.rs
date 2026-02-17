//! API Server Module
//!
//! Provides the Axum application builder and server startup logic.
//! Consolidates application state and router configuration.

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::deposit_tracker::db::StealthDepositStore;
use crate::deposit_tracker::service::DepositTrackerService;
use crate::deposit_tracker::websocket::{create_ws_state, SharedWebSocketState};

/// Combined application state for all API endpoints
pub struct AppState {
    /// Deposit tracker service
    pub tracker: Arc<RwLock<DepositTrackerService>>,
    /// WebSocket state for real-time updates
    pub ws_state: SharedWebSocketState,
    /// Stealth deposit store (V2)
    pub stealth_store: StealthDepositStore,
}

/// Shared application state type
pub type SharedAppState = Arc<AppState>;

impl AppState {
    /// Create new application state with the given tracker service
    pub fn new(tracker: DepositTrackerService) -> SharedAppState {
        let ws_state = create_ws_state();
        let tracker_with_ws = tracker.with_websocket(ws_state.clone());

        Arc::new(Self {
            tracker: Arc::new(RwLock::new(tracker_with_ws)),
            ws_state,
            stealth_store: StealthDepositStore::new(),
        })
    }
}
