//! Pool configuration PDA — extended fields that don't fit in PoolState
//!
//! Stores the pool's BTC scriptPubKey (P2TR) and FROST group public key
//! on-chain for trustless verification in `complete_redemption` and
//! `verify_deposit_v2`.
//!
//! PDA seeds: ["pool_config"]

use pinocchio::program_error::ProgramError;

/// Discriminator for PoolConfig account
pub const POOL_CONFIG_DISCRIMINATOR: u8 = 0x0A;

/// Pool configuration account (zero-copy layout, 96 bytes)
#[repr(C)]
pub struct PoolConfig {
    /// Account discriminator (1 byte)
    pub discriminator: u8,

    /// Length of pool_script (0 = not set, max 34 for P2TR)
    pub pool_script_len: u8,

    /// Pool wallet's BTC scriptPubKey (P2TR = 0x5120 + 32-byte x-only pubkey)
    pub pool_script: [u8; 34],

    /// FROST group x-only public key (32 bytes, big-endian)
    /// Used by verify_deposit_v2 to verify npk ↔ Taproot address binding
    pub group_pub_key: [u8; 32],

    /// Reserved for future use
    _reserved: [u8; 28],
}

impl PoolConfig {
    pub const LEN: usize = core::mem::size_of::<Self>(); // 96 bytes
    pub const SEED: &'static [u8] = b"pool_config";

    /// Maximum pool_script length (P2TR scriptPubKey)
    pub const MAX_SCRIPT_LEN: usize = 34;

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != POOL_CONFIG_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != POOL_CONFIG_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new PoolConfig
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = POOL_CONFIG_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Get the pool script slice (empty if not set)
    pub fn get_pool_script(&self) -> &[u8] {
        let len = self.pool_script_len as usize;
        if len == 0 || len > Self::MAX_SCRIPT_LEN {
            return &[];
        }
        &self.pool_script[..len]
    }

    /// Set pool script
    pub fn set_pool_script(&mut self, script: &[u8]) -> Result<(), ProgramError> {
        if script.len() > Self::MAX_SCRIPT_LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        self.pool_script_len = script.len() as u8;
        self.pool_script = [0u8; 34];
        self.pool_script[..script.len()].copy_from_slice(script);
        Ok(())
    }

    /// Get the FROST group public key (returns zeros if not set)
    pub fn get_group_pub_key(&self) -> &[u8; 32] {
        &self.group_pub_key
    }

    /// Check if group_pub_key is set (non-zero)
    pub fn has_group_pub_key(&self) -> bool {
        self.group_pub_key != [0u8; 32]
    }

    /// Set the FROST group public key
    pub fn set_group_pub_key(&mut self, key: &[u8; 32]) {
        self.group_pub_key = *key;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pool_config_size() {
        assert_eq!(PoolConfig::LEN, 96);
    }

    #[test]
    fn test_pool_config_init_and_set() {
        let mut buf = vec![0u8; PoolConfig::LEN];
        let config = PoolConfig::init(&mut buf).unwrap();

        assert_eq!(config.pool_script_len, 0);
        assert_eq!(config.get_pool_script(), &[] as &[u8]);
        assert!(!config.has_group_pub_key());

        // P2TR script: 0x5120 + 32 bytes
        let mut script = [0u8; 34];
        script[0] = 0x51;
        script[1] = 0x20;
        script[2..].fill(0xAB);

        config.set_pool_script(&script).unwrap();
        assert_eq!(config.pool_script_len, 34);
        assert_eq!(config.get_pool_script(), &script);

        // Group pub key
        let key = [0x42u8; 32];
        config.set_group_pub_key(&key);
        assert!(config.has_group_pub_key());
        assert_eq!(config.get_group_pub_key(), &key);
    }

    #[test]
    fn test_pool_config_script_too_long() {
        let mut buf = vec![0u8; PoolConfig::LEN];
        let config = PoolConfig::init(&mut buf).unwrap();

        let script = [0u8; 35];
        assert!(config.set_pool_script(&script).is_err());
    }

    #[test]
    fn test_pool_config_roundtrip() {
        let mut buf = vec![0u8; PoolConfig::LEN];
        {
            let config = PoolConfig::init(&mut buf).unwrap();
            let script = [0x51, 0x20, 0x01, 0x02];
            config.set_pool_script(&script).unwrap();
            config.set_group_pub_key(&[0xBB; 32]);
        }
        let config = PoolConfig::from_bytes(&buf).unwrap();
        assert_eq!(config.get_pool_script(), &[0x51, 0x20, 0x01, 0x02]);
        assert_eq!(config.get_group_pub_key(), &[0xBB; 32]);
    }
}
