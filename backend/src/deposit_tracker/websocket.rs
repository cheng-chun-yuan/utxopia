//! WebSocket Handler for Deposit Status Updates
//!
//! Provides real-time status updates to connected clients.
//! Uses tokio broadcast channels for pub/sub.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use super::types::DepositStatusUpdate;

/// WebSocket state shared across handlers
pub struct WebSocketState {
    /// Broadcast sender for status updates
    sender: broadcast::Sender<DepositStatusUpdate>,
}

impl WebSocketState {
    /// Create new WebSocket state with specified capacity
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// Get a sender clone for publishing updates
    pub fn sender(&self) -> broadcast::Sender<DepositStatusUpdate> {
        self.sender.clone()
    }

    /// Subscribe to updates
    pub fn subscribe(&self) -> broadcast::Receiver<DepositStatusUpdate> {
        self.sender.subscribe()
    }

    /// Publish an update to all subscribers
    pub fn publish(&self, update: DepositStatusUpdate) {
        // Ignore send errors (no subscribers)
        let _ = self.sender.send(update);
    }
}

impl Default for WebSocketState {
    fn default() -> Self {
        Self::new(100)
    }
}

/// Shared WebSocket state type
pub type SharedWebSocketState = Arc<RwLock<WebSocketState>>;

/// Create shared WebSocket state
pub fn create_ws_state() -> SharedWebSocketState {
    Arc::new(RwLock::new(WebSocketState::default()))
}

/// WebSocket upgrade handler for specific deposit
///
/// Route: /ws/deposits/:id
pub async fn ws_deposit_handler(
    ws: WebSocketUpgrade,
    Path(deposit_id): Path<String>,
    State(state): State<SharedWebSocketState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, deposit_id, state))
}

/// Handle individual WebSocket connection
async fn handle_socket(socket: WebSocket, deposit_id: String, state: SharedWebSocketState) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to updates
    let ws_state = state.read().await;
    let mut rx = ws_state.subscribe();
    drop(ws_state);

    // Spawn task to forward updates to this client
    let deposit_id_clone = deposit_id.clone();
    let send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            // Only send updates for the subscribed deposit
            if update.deposit_id == deposit_id_clone {
                let json = match serde_json::to_string(&update) {
                    Ok(j) => j,
                    Err(_) => continue,
                };

                if sender.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
        }
    });

    // Handle incoming messages (ping/pong, close)
    let recv_task = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Ping(data)) => {
                    // Pong is handled automatically by axum
                    let _ = data;
                }
                Ok(Message::Close(_)) => {
                    break;
                }
                Ok(Message::Text(text)) => {
                    // Handle any client messages if needed
                    // For now, we just log them
                    println!("WS received from {}: {}", deposit_id, text);
                }
                Err(_) => {
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for either task to complete
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}

/// WebSocket upgrade handler for all deposit updates
///
/// Route: /ws/deposits
/// Receives updates for all deposits (useful for admin dashboards)
pub async fn ws_all_deposits_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedWebSocketState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket_all(socket, state))
}

/// Handle WebSocket connection for all deposits
async fn handle_socket_all(socket: WebSocket, state: SharedWebSocketState) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to updates
    let ws_state = state.read().await;
    let mut rx = ws_state.subscribe();
    drop(ws_state);

    // Spawn task to forward ALL updates to this client
    let send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            let json = match serde_json::to_string(&update) {
                Ok(j) => j,
                Err(_) => continue,
            };

            if sender.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages
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

/// Publisher for broadcasting deposit updates
pub struct DepositUpdatePublisher {
    state: SharedWebSocketState,
}

impl DepositUpdatePublisher {
    /// Create a new publisher
    pub fn new(state: SharedWebSocketState) -> Self {
        Self { state }
    }

    /// Publish a deposit status update
    pub async fn publish(&self, update: DepositStatusUpdate) {
        let ws_state = self.state.read().await;
        ws_state.publish(update);
    }

    /// Publish status for a deposit record
    pub async fn publish_deposit_status(&self, record: &super::types::DepositRecord) {
        let update = DepositStatusUpdate::from(record);
        self.publish(update).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_websocket_state() {
        let state = WebSocketState::new(10);

        // Subscribe before publishing
        let mut rx = state.subscribe();

        // Publish update
        let update = DepositStatusUpdate {
            deposit_id: "test_123".to_string(),
            status: "confirming".to_string(),
            confirmations: 3,
            sweep_confirmations: 0,
            can_claim: false,
            error: None,
        };

        state.publish(update.clone());

        // Should receive the update
        let received = rx.recv().await.unwrap();
        assert_eq!(received.deposit_id, "test_123");
        assert_eq!(received.confirmations, 3);
    }

    #[tokio::test]
    async fn test_multiple_subscribers() {
        let state = WebSocketState::new(10);

        let mut rx1 = state.subscribe();
        let mut rx2 = state.subscribe();

        let update = DepositStatusUpdate {
            deposit_id: "test_456".to_string(),
            status: "ready".to_string(),
            confirmations: 6,
            sweep_confirmations: 2,
            can_claim: true,
            error: None,
        };

        state.publish(update);

        // Both subscribers should receive
        let r1 = rx1.recv().await.unwrap();
        let r2 = rx2.recv().await.unwrap();

        assert_eq!(r1.deposit_id, r2.deposit_id);
        assert_eq!(r1.can_claim, true);
        assert_eq!(r2.can_claim, true);
    }
}
