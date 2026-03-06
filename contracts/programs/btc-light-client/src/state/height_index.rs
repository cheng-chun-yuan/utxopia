use crate::constants::HEIGHT_INDEX_DISCRIMINATOR;
use pinocchio::program_error::ProgramError;

/// HeightIndex PDA — maps a block height to the canonical block hash at that height.
/// Seeds: ["height_index", height_le_bytes(8)]
/// Size: 48 bytes
#[repr(C)]
pub(crate) struct HeightIndex {
    pub discriminator: u8,
    pub bump: u8,
    pub _padding: [u8; 6],
    pub block_hash: [u8; 32],
    pub height: [u8; 8],
}

impl HeightIndex {
    pub const LEN: usize = core::mem::size_of::<Self>(); // 48 bytes

    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != HEIGHT_INDEX_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    pub fn height(&self) -> u64 {
        u64::from_le_bytes(self.height)
    }
}
