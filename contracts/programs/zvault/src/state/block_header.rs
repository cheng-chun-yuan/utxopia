//! Bitcoin Block Header storage account (zero-copy)

use pinocchio::program_error::ProgramError;

/// Discriminator for BlockHeader account
pub const BLOCK_HEADER_DISCRIMINATOR: u8 = 0x07;

/// Bitcoin block header account (zero-copy layout)
/// Stores a single Bitcoin block header for SPV proofs
#[repr(C)]
pub struct BlockHeader {
    /// Account discriminator
    pub discriminator: u8,

    /// Padding for alignment
    _padding: [u8; 3],

    /// Block version
    pub version: [u8; 4],

    /// Hash of the previous block
    pub prev_block_hash: [u8; 32],

    /// Merkle root of all transactions in block
    pub merkle_root: [u8; 32],

    /// Block timestamp (Unix time)
    pub timestamp: [u8; 4],

    /// Difficulty target (compact format)
    pub bits: [u8; 4],

    /// Nonce used for PoW
    pub nonce: [u8; 4],

    /// Computed block hash (double SHA256)
    pub block_hash: [u8; 32],

    /// Cumulative chainwork up to this block
    pub chainwork: [u8; 32],

    /// Block height in the chain
    height: [u8; 8],

    /// When this header was submitted
    submitted_at: [u8; 8],

    /// Reserved for future use
    _reserved: [u8; 32],
}

impl BlockHeader {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"block_header";
    pub const RAW_HEADER_SIZE: usize = 80;

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new block header in the given buffer
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = BLOCK_HEADER_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn version(&self) -> i32 {
        i32::from_le_bytes(self.version)
    }

    pub fn timestamp_u32(&self) -> u32 {
        u32::from_le_bytes(self.timestamp)
    }

    pub fn bits_u32(&self) -> u32 {
        u32::from_le_bytes(self.bits)
    }

    pub fn nonce_u32(&self) -> u32 {
        u32::from_le_bytes(self.nonce)
    }

    pub fn height(&self) -> u64 {
        u64::from_le_bytes(self.height)
    }

    pub fn submitted_at(&self) -> i64 {
        i64::from_le_bytes(self.submitted_at)
    }

    // Setters
    pub fn set_version(&mut self, value: i32) {
        self.version = value.to_le_bytes();
    }

    pub fn set_timestamp(&mut self, value: u32) {
        self.timestamp = value.to_le_bytes();
    }

    pub fn set_bits(&mut self, value: u32) {
        self.bits = value.to_le_bytes();
    }

    pub fn set_nonce(&mut self, value: u32) {
        self.nonce = value.to_le_bytes();
    }

    pub fn set_height(&mut self, value: u64) {
        self.height = value.to_le_bytes();
    }

    pub fn set_submitted_at(&mut self, value: i64) {
        self.submitted_at = value.to_le_bytes();
    }

    /// Parse from raw Bitcoin header format (80 bytes)
    pub fn parse_raw_header(&mut self, raw: &[u8; 80], block_height: u64) {
        self.version.copy_from_slice(&raw[0..4]);
        self.prev_block_hash.copy_from_slice(&raw[4..36]);
        self.merkle_root.copy_from_slice(&raw[36..68]);
        self.timestamp.copy_from_slice(&raw[68..72]);
        self.bits.copy_from_slice(&raw[72..76]);
        self.nonce.copy_from_slice(&raw[76..80]);
        self.set_height(block_height);
    }

    /// Serialize to raw Bitcoin header format (80 bytes)
    pub fn to_raw_header(&self) -> [u8; 80] {
        let mut header = [0u8; 80];
        header[0..4].copy_from_slice(&self.version);
        header[4..36].copy_from_slice(&self.prev_block_hash);
        header[36..68].copy_from_slice(&self.merkle_root);
        header[68..72].copy_from_slice(&self.timestamp);
        header[72..76].copy_from_slice(&self.bits);
        header[76..80].copy_from_slice(&self.nonce);
        header
    }

    /// Get difficulty target from bits (compact format)
    pub fn target(&self) -> [u8; 32] {
        let bits = self.bits_u32();
        let mut target = [0u8; 32];
        let exponent = ((bits >> 24) & 0xff) as usize;
        let mantissa = bits & 0x007fffff;

        if exponent <= 3 {
            let shift = 8 * (3 - exponent);
            let value = mantissa >> shift;
            target[0..4].copy_from_slice(&value.to_le_bytes());
        } else {
            let byte_offset = exponent - 3;
            if byte_offset < 29 {
                target[byte_offset..byte_offset + 3].copy_from_slice(&mantissa.to_le_bytes()[0..3]);
            }
        }

        target
    }
}

/// SPV Transaction Merkle Proof
/// Proves a transaction is included in a block
pub struct TxMerkleProof<'a> {
    /// Transaction hash (txid)
    pub txid: [u8; 32],

    /// Merkle proof siblings (from leaf to root)
    /// Each sibling is 32 bytes
    pub siblings: &'a [[u8; 32]],

    /// Path indices (0 = left, 1 = right) packed as bits
    /// bit i = 0 means current hash goes on left at level i
    pub path_bits: u32,

    /// Number of levels in the proof
    pub path_len: u8,

    /// Transaction index in block
    pub tx_index: u32,
}

impl<'a> TxMerkleProof<'a> {
    /// Maximum proof depth (2^20 = ~1M transactions per block)
    pub const MAX_DEPTH: usize = 20;

    /// Parse merkle proof from instruction data
    /// Format: [txid(32)][path_bits(4)][path_len(1)][tx_index(4)][siblings...]
    pub fn parse(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < 41 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut txid = [0u8; 32];
        txid.copy_from_slice(&data[0..32]);

        let path_bits = u32::from_le_bytes(data[32..36].try_into().unwrap());
        let path_len = data[36];
        let tx_index = u32::from_le_bytes(data[37..41].try_into().unwrap());

        if path_len as usize > Self::MAX_DEPTH {
            return Err(ProgramError::InvalidInstructionData);
        }

        let siblings_start = 41;
        let siblings_len = path_len as usize;
        let expected_len = siblings_start + siblings_len * 32;

        if data.len() < expected_len {
            return Err(ProgramError::InvalidInstructionData);
        }

        // Safe: we verified the length above
        let siblings_data = &data[siblings_start..expected_len];
        let siblings = unsafe {
            core::slice::from_raw_parts(
                siblings_data.as_ptr() as *const [u8; 32],
                siblings_len,
            )
        };

        Ok(Self {
            txid,
            siblings,
            path_bits,
            path_len,
            tx_index,
        })
    }

    /// Verify the proof against a merkle root using double SHA256
    pub fn verify(&self, merkle_root: &[u8; 32]) -> bool {
        use crate::utils::bitcoin::double_sha256_pair;

        let mut current = self.txid;

        for (i, sibling) in self.siblings.iter().enumerate() {
            let is_right = (self.path_bits >> i) & 1 == 1;
            current = if is_right {
                double_sha256_pair(sibling, &current)
            } else {
                double_sha256_pair(&current, sibling)
            };
        }

        current == *merkle_root
    }

    /// Get the byte length of serialized proof
    pub fn byte_len(&self) -> usize {
        41 + (self.path_len as usize) * 32
    }
}
