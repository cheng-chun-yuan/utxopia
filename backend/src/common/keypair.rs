//! Keypair loading utility
//!
//! Loads a Solana keypair from either an inline JSON byte array or a file path.

use solana_sdk::signer::keypair::Keypair;

/// Load a Solana `Keypair` from a string value.
///
/// If the value starts with `[`, it is parsed as a JSON byte array.
/// Otherwise, it is treated as a file path.
pub fn load_keypair(value: &str) -> Result<Keypair, String> {
    if value.starts_with('[') {
        serde_json::from_str::<Vec<u8>>(value)
            .map_err(|e| format!("parse keypair JSON: {}", e))
            .and_then(|bytes| {
                Keypair::try_from(bytes.as_slice())
                    .map_err(|e| format!("invalid keypair: {}", e))
            })
    } else {
        crate::load_keypair_from_file(value).map_err(|e| format!("{}", e))
    }
}
