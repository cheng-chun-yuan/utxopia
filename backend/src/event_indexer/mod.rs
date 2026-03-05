//! Event indexer for Aegis sol_log_data events
//!
//! Parses LeafInserted and NullifierSpent events from on-chain transaction logs,
//! stores them in SQLite, and serves them via REST API endpoints.
//! Maintains an in-memory Merkle tree cache for instant proof serving.

pub mod parser;
pub mod storage;
pub mod service;
pub mod routes;
pub mod tree_cache;

pub use parser::{ProgramEvent, LeafInsertedEvent, NullifierSpentEvent};
pub use storage::EventStore;
pub use service::{EventIndexerConfig, EventIndexerService};
pub use routes::event_indexer_router;
pub use tree_cache::TreeCache;
