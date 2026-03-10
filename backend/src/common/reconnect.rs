//! Exponential backoff reconnect loop
//!
//! Shared utility for services that need to maintain a persistent connection
//! (e.g. WebSocket clients) with automatic reconnection on failure.

use std::future::Future;
use std::time::Duration;

/// Run a connect-and-listen function in a loop with exponential backoff.
///
/// On success (Ok), the delay resets to `initial_delay`.
/// On failure (Err), the delay doubles up to `max_delay`.
pub async fn reconnect_loop<F, Fut>(
    label: &str,
    initial_delay: Duration,
    max_delay: Duration,
    mut connect_fn: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut delay = initial_delay;

    loop {
        tracing::info!("[{}] Connecting...", label);

        match connect_fn().await {
            Ok(()) => {
                tracing::info!("[{}] Connection closed, reconnecting...", label);
                delay = initial_delay;
            }
            Err(e) => {
                tracing::warn!(
                    "[{}] Error: {}, reconnecting in {}s...",
                    label,
                    e,
                    delay.as_secs()
                );
            }
        }

        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(max_delay);
    }
}
