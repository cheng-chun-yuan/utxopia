//! Generic WebSocket broadcast handler
//!
//! Provides a reusable function for forwarding broadcast channel messages
//! to a WebSocket connection with automatic close/error handling.

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::broadcast;

/// Run a WebSocket connection that forwards broadcast messages to the client.
///
/// Optionally filters messages before sending. Handles close frames and
/// errors automatically. Returns when either the send or receive side closes.
pub async fn run_broadcast_ws<T: Serialize + Clone + Send + 'static>(
    socket: WebSocket,
    mut rx: broadcast::Receiver<T>,
    filter: Option<Box<dyn Fn(&T) -> bool + Send>>,
    label: &str,
) {
    let (mut sender, mut receiver) = socket.split();

    let label_owned = label.to_string();
    let send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            if let Some(ref f) = filter {
                if !f(&update) {
                    continue;
                }
            }
            let json = match serde_json::to_string(&update) {
                Ok(j) => j,
                Err(_) => continue,
            };
            if sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if !label_owned.is_empty() {
                        println!("WS received from {}: {}", label_owned, text);
                    }
                }
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
