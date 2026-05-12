//! Event indexer for UTXOpia sol_log_data events
//!
//! Parses NullifierSpent and StealthAnnouncement events from on-chain transaction logs,
//! stores them in SQLite, and serves them via REST API endpoints.
//! Maintains an in-memory Merkle tree cache for instant proof serving.

pub mod parser;
pub mod storage;
pub mod service;
pub mod routes;
pub mod tree_cache;
pub mod solana_ws;
pub mod reconciler;

pub use parser::{ProgramEvent, NullifierSpentEvent, StealthAnnouncementEvent};
pub use storage::EventStore;
pub use service::{EventIndexerConfig, EventIndexerService};
pub use routes::{event_indexer_router, event_indexer_router_with_deposits};
pub use tree_cache::TreeCache;
pub use solana_ws::{SolanaWsConfig, SolanaWsSubscriber};
pub use reconciler::Reconciler;
