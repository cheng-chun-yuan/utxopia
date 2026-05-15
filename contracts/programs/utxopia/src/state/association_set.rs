//! Association set state (Phase 3 — Proof of Innocence)
//!
//! Stores the current root of the off-chain-curated association tree of
//! "clean" commitments. The operator updates this root via
//! `update_association_root` (disc 21). The user-facing `attest_poi` (disc
//! 22) and `attest_poi_hidden` (disc 23) instructions read this root and
//! verify the user-supplied PoI Groth16 proof against it.
//!
//! The passive-attestation flow (registered screeners signing per-commitment
//! verdicts) is a complementary path — it doesn't read this PDA, but the
//! association root is still useful for the user-driven PoI fallback path
//! and for backwards compatibility with consumers that index PoI events.

use core::mem::size_of;

/// 8-byte discriminator distinguishing this PDA from others.
pub const ASSOCIATION_SET_DISCRIMINATOR: [u8; 8] =
    [b'P', b'O', b'I', b'A', b'S', b'S', b'O', b'C'];

#[repr(C)]
pub struct AssociationSet {
    /// Anchor discriminator, must match `ASSOCIATION_SET_DISCRIMINATOR`.
    pub discriminator: [u8; 8],
    /// Current curated root of the association tree.
    pub current_root: [u8; 32],
    /// Bump used when deriving the PDA.
    pub bump: u8,
    /// 0 = active, 1 = paused (PoI-tagged withdrawals refused while paused).
    pub status: u8,
    /// Solana slot at which `current_root` was last updated.
    pub last_updated_slot: u64,
    /// Monotonic counter so off-chain consumers can detect missed updates.
    pub version: u64,
    /// Reserved for future use; keeps the struct size stable when fields are added.
    pub _reserved: [u8; 30],
}

impl AssociationSet {
    pub const LEN: usize = size_of::<Self>();

    pub fn is_initialized(data: &[u8]) -> bool {
        data.len() >= 8 && data[..8] == ASSOCIATION_SET_DISCRIMINATOR
    }

    pub fn from_bytes(data: &[u8]) -> Result<&Self, pinocchio::program_error::ProgramError> {
        if data.len() < Self::LEN || !Self::is_initialized(data) {
            return Err(pinocchio::program_error::ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    pub fn from_bytes_mut(
        data: &mut [u8],
    ) -> Result<&mut Self, pinocchio::program_error::ProgramError> {
        if data.len() < Self::LEN || !Self::is_initialized(data) {
            return Err(pinocchio::program_error::ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    pub fn init(
        data: &mut [u8],
        bump: u8,
    ) -> Result<&mut Self, pinocchio::program_error::ProgramError> {
        if data.len() < Self::LEN {
            return Err(pinocchio::program_error::ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[..8].copy_from_slice(&ASSOCIATION_SET_DISCRIMINATOR);
        let s = unsafe { &mut *(data.as_mut_ptr() as *mut Self) };
        s.bump = bump;
        Ok(s)
    }
}

/// PDA seed for the association-set account.
pub const ASSOCIATION_SET_SEED: &[u8] = b"poi_association_set";
