//! WebSocket Handler Module
//!
//! Real-time status updates via WebSocket connections.
//! Re-exports from the deposit_tracker websocket module.

// Re-export WebSocket functionality from deposit_tracker
pub use crate::deposit_tracker::websocket::{
    create_ws_state, ws_all_deposits_handler, ws_deposit_handler, DepositUpdatePublisher,
    SharedWebSocketState, WebSocketState,
};
