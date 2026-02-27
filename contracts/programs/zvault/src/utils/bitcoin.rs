//! Bitcoin utilities for SPV verification
//!
//! Provides SHA256 hashing and Bitcoin transaction parsing.

use pinocchio::program_error::ProgramError;

use crate::error::ZVaultError;

/// OP_RETURN opcode
pub const OP_RETURN: u8 = 0x6a;

/// Commitment size (32 bytes)
pub const COMMITMENT_SIZE: usize = 32;

/// Magic byte for stealth OP_RETURN
pub const STEALTH_OP_RETURN_MAGIC: u8 = 0x7A; // 'z' for zVault stealth

/// Current version for stealth OP_RETURN format (simplified)
pub const STEALTH_OP_RETURN_VERSION: u8 = 2;

/// Legacy version for backward compatibility
pub const STEALTH_OP_RETURN_VERSION_V1: u32 = 1;

/// Total size of stealth OP_RETURN data (SIMPLIFIED - 99 bytes)
/// = 1 (magic) + 1 (version) + 32 (view pub) + 32 (spend pub) + 32 (commitment)
pub const STEALTH_OP_RETURN_SIZE: usize = 98;

/// Legacy size for V1 format
pub const STEALTH_OP_RETURN_SIZE_V1: usize = 142;

/// Parsed stealth data from OP_RETURN
pub struct StealthOpReturnData {
    pub version: u8,
    pub ephemeral_view_pub: [u8; 32],
    pub ephemeral_spend_pub: [u8; 32],
    pub commitment: [u8; 32],
}

impl StealthOpReturnData {
    /// Parse stealth data from OP_RETURN output data
    /// Supports both V2 (98 bytes) and V1 (142 bytes) formats.
    pub fn parse(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < STEALTH_OP_RETURN_SIZE {
            return Err(ZVaultError::InvalidStealthOpReturn.into());
        }

        if data[0] != STEALTH_OP_RETURN_MAGIC {
            return Err(ZVaultError::InvalidStealthOpReturn.into());
        }

        let version = data[1];

        if version == STEALTH_OP_RETURN_VERSION {
            // V2: Simplified format (98 bytes)
            let mut ephemeral_view_pub = [0u8; 32];
            ephemeral_view_pub.copy_from_slice(&data[2..34]);

            let mut ephemeral_spend_pub = [0u8; 32];
            ephemeral_spend_pub.copy_from_slice(&data[34..66]);

            let mut commitment = [0u8; 32];
            commitment.copy_from_slice(&data[66..98]);

            Ok(Self {
                version,
                ephemeral_view_pub,
                ephemeral_spend_pub,
                commitment,
            })
        } else if data.len() >= STEALTH_OP_RETURN_SIZE_V1 {
            // V1: Legacy format (142 bytes)
            let version_v1 = u32::from_le_bytes(data[1..5].try_into().unwrap());
            if version_v1 != STEALTH_OP_RETURN_VERSION_V1 {
                return Err(ZVaultError::InvalidStealthOpReturn.into());
            }

            let mut ephemeral_view_pub = [0u8; 32];
            ephemeral_view_pub.copy_from_slice(&data[5..37]);

            let mut ephemeral_spend_pub = [0u8; 32];
            ephemeral_spend_pub.copy_from_slice(&data[37..69]);

            let mut commitment = [0u8; 32];
            commitment.copy_from_slice(&data[109..141]);

            Ok(Self {
                version: 1,
                ephemeral_view_pub,
                ephemeral_spend_pub,
                commitment,
            })
        } else {
            Err(ZVaultError::InvalidStealthOpReturn.into())
        }
    }
}

/// Double SHA256 hash (Bitcoin standard)
/// Uses Solana's native SHA256 syscall for efficiency
pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = sha256(data);
    sha256(&first)
}

/// SHA256 hash using Solana's syscall
pub fn sha256(data: &[u8]) -> [u8; 32] {
    // Solana provides sol_sha256 syscall
    let mut result = [0u8; 32];

    #[cfg(target_os = "solana")]
    {
        // Use Solana's hashv syscall via pinocchio
        // Note: pinocchio uses sol_sha256 internally
        unsafe {
            extern "C" {
                fn sol_sha256(vals: *const u8, val_len: u64, hash_result: *mut u8) -> u64;
            }

            // Create the slice descriptor that sol_sha256 expects
            let slice_desc = [data.as_ptr(), data.len() as *const u8];
            sol_sha256(slice_desc.as_ptr() as *const u8, 1, result.as_mut_ptr());
        }
    }

    #[cfg(not(target_os = "solana"))]
    {
        // For testing, use a simple XOR-based hash (not cryptographically secure)
        for (i, byte) in data.iter().enumerate() {
            result[i % 32] ^= byte;
            result[(i + 1) % 32] = result[(i + 1) % 32].wrapping_add(*byte);
        }
    }

    result
}

/// Double SHA256 hash of two 32-byte values concatenated
/// Used for Bitcoin merkle tree computation
pub fn double_sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = [0u8; 64];
    combined[0..32].copy_from_slice(left);
    combined[32..64].copy_from_slice(right);
    double_sha256(&combined)
}

/// Compute Bitcoin transaction hash (double SHA256)
pub fn compute_tx_hash(raw_tx: &[u8]) -> [u8; 32] {
    double_sha256(raw_tx)
}

/// Compute transaction ID (reversed hash, as displayed)
pub fn compute_txid(raw_tx: &[u8]) -> [u8; 32] {
    let mut hash = compute_tx_hash(raw_tx);
    hash.reverse();
    hash
}

/// Check if a hash meets the difficulty target
/// Hash must be less than or equal to target (little-endian comparison)
pub fn hash_meets_target(hash: &[u8; 32], target: &[u8; 32]) -> bool {
    // Compare from most significant byte
    for i in (0..32).rev() {
        if hash[i] > target[i] {
            return false;
        }
        if hash[i] < target[i] {
            return true;
        }
    }
    true // Equal
}

/// Get difficulty target from compact bits format
pub fn target_from_bits(bits: u32) -> [u8; 32] {
    let mut target = [0u8; 32];
    let exponent = ((bits >> 24) & 0xff) as usize;
    let mantissa = bits & 0x007fffff;

    if exponent <= 3 {
        let shift = 8 * (3 - exponent);
        let value = mantissa >> shift;
        target[0..4].copy_from_slice(&value.to_le_bytes());
    } else {
        let byte_offset = exponent - 3;
        if byte_offset + 3 <= 32 {
            target[byte_offset..byte_offset + 3].copy_from_slice(&mantissa.to_le_bytes()[0..3]);
        }
    }

    target
}

/// Calculate chainwork from difficulty bits: work = 2^256 / (target + 1)
pub fn calculate_chainwork(bits: u32) -> [u8; 32] {
    let target = target_from_bits(bits);

    // target_plus_one = target + 1
    let mut target_plus_one = [0u8; 32];
    let mut carry: u16 = 1;
    for i in 0..32 {
        let sum = target[i] as u16 + carry;
        target_plus_one[i] = sum as u8;
        carry = sum >> 8;
    }

    if target_plus_one == [0u8; 32] {
        return [0u8; 32];
    }

    // (~target) / (target+1) + 1 = 2^256 / (target+1)
    let mut not_target = [0u8; 32];
    for i in 0..32 {
        not_target[i] = !target[i];
    }

    let dividend = u256_from_le_bytes(&not_target);
    let divisor = u256_from_le_bytes(&target_plus_one);
    let quotient = u256_div(dividend, divisor);
    let result = u256_add(quotient, [1, 0, 0, 0]);
    u256_to_le_bytes(result)
}

// --- 256-bit arithmetic helpers ---

fn u256_from_le_bytes(bytes: &[u8; 32]) -> [u64; 4] {
    [
        u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
        u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
    ]
}

fn u256_to_le_bytes(v: [u64; 4]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&v[0].to_le_bytes());
    out[8..16].copy_from_slice(&v[1].to_le_bytes());
    out[16..24].copy_from_slice(&v[2].to_le_bytes());
    out[24..32].copy_from_slice(&v[3].to_le_bytes());
    out
}

fn u256_add(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    let mut result = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        let (s1, c1) = a[i].overflowing_add(b[i]);
        let (s2, c2) = s1.overflowing_add(carry);
        result[i] = s2;
        carry = (c1 as u64) + (c2 as u64);
    }
    result
}

fn u256_gte(a: [u64; 4], b: [u64; 4]) -> bool {
    for i in (0..4).rev() {
        if a[i] > b[i] { return true; }
        if a[i] < b[i] { return false; }
    }
    true
}

fn u256_sub(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    let mut result = [0u64; 4];
    let mut borrow = 0u64;
    for i in 0..4 {
        let (s1, c1) = a[i].overflowing_sub(b[i]);
        let (s2, c2) = s1.overflowing_sub(borrow);
        result[i] = s2;
        borrow = (c1 as u64) + (c2 as u64);
    }
    result
}

fn u256_shl(v: [u64; 4], shift: u32) -> [u64; 4] {
    if shift >= 256 { return [0; 4]; }
    let limb_shift = (shift / 64) as usize;
    let bit_shift = shift % 64;
    let mut result = [0u64; 4];
    for i in limb_shift..4 {
        result[i] = v[i - limb_shift] << bit_shift;
        if bit_shift > 0 && i > limb_shift {
            result[i] |= v[i - limb_shift - 1] >> (64 - bit_shift);
        }
    }
    result
}

fn u256_clz(v: [u64; 4]) -> u32 {
    for i in (0..4).rev() {
        if v[i] != 0 {
            return (3 - i as u32) * 64 + v[i].leading_zeros();
        }
    }
    256
}

fn u256_div(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    if b == [0, 0, 0, 0] { return [0; 4]; }
    if !u256_gte(a, b) { return [0; 4]; }

    let a_clz = u256_clz(a);
    let b_clz = u256_clz(b);
    if b_clz < a_clz { return [0; 4]; }

    let shift_max = b_clz - a_clz;
    let mut remainder = a;
    let mut quotient = [0u64; 4];

    for s in (0..=shift_max).rev() {
        let shifted = u256_shl(b, s);
        if u256_gte(remainder, shifted) {
            remainder = u256_sub(remainder, shifted);
            let limb = (s / 64) as usize;
            let bit = s % 64;
            quotient[limb] |= 1u64 << bit;
        }
    }
    quotient
}

/// Add two chainwork values (256-bit addition)
pub fn add_chainwork(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut carry: u16 = 0;

    for i in 0..32 {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        result[i] = sum as u8;
        carry = sum >> 8;
    }

    result
}

/// Parsed Bitcoin transaction output
pub struct TxOutput<'a> {
    /// Output value in satoshis
    pub value: u64,
    /// Script pubkey (locking script)
    pub script_pubkey: &'a [u8],
}

impl<'a> TxOutput<'a> {
    /// Check if this output is an OP_RETURN
    pub fn is_op_return(&self) -> bool {
        !self.script_pubkey.is_empty() && self.script_pubkey[0] == OP_RETURN
    }

    /// Extract 32-byte commitment from OP_RETURN
    /// Format: OP_RETURN <push_opcode> <data>
    pub fn get_commitment(&self) -> Option<[u8; 32]> {
        if !self.is_op_return() || self.script_pubkey.len() < 2 {
            return None;
        }

        let push_len = self.script_pubkey[1] as usize;
        if self.script_pubkey.len() < 2 + push_len || push_len < COMMITMENT_SIZE {
            return None;
        }

        let mut commitment = [0u8; 32];
        commitment.copy_from_slice(&self.script_pubkey[2..2 + COMMITMENT_SIZE]);
        Some(commitment)
    }

    /// Check if this is a stealth OP_RETURN (starts with magic byte 0x7A)
    /// Supports both V2 (99 bytes) and V1 (142 bytes) formats.
    pub fn is_stealth_op_return(&self) -> bool {
        if !self.is_op_return() || self.script_pubkey.len() < 3 {
            return false;
        }

        let push_len = self.script_pubkey[1] as usize;
        // Accept both V2 (99 bytes) and V1 (142 bytes) sizes
        if self.script_pubkey.len() < 2 + push_len || push_len < STEALTH_OP_RETURN_SIZE {
            return false;
        }

        // Check magic byte
        self.script_pubkey[2] == STEALTH_OP_RETURN_MAGIC
    }

    /// Get raw OP_RETURN data (after opcode and push length)
    pub fn get_op_return_data(&self) -> Option<&'a [u8]> {
        if !self.is_op_return() || self.script_pubkey.len() < 2 {
            return None;
        }

        let push_len = self.script_pubkey[1] as usize;
        if self.script_pubkey.len() < 2 + push_len {
            return None;
        }

        Some(&self.script_pubkey[2..2 + push_len])
    }
}

/// Parsed Bitcoin transaction (minimal, zero-copy where possible)
pub struct ParsedTransaction<'a> {
    /// Transaction version
    pub version: i32,
    /// Raw outputs data slice
    outputs_data: &'a [u8],
    /// Output count
    output_count: usize,
    /// Is segwit transaction
    pub is_segwit: bool,
}

impl<'a> ParsedTransaction<'a> {
    /// Parse a raw Bitcoin transaction
    /// Returns parsed transaction with references to output data
    pub fn parse(raw_tx: &'a [u8]) -> Result<Self, ProgramError> {
        if raw_tx.len() < 10 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut offset = 0;

        // Version (4 bytes)
        let version = i32::from_le_bytes(raw_tx[0..4].try_into().unwrap());
        offset += 4;

        // Check for segwit marker
        let is_segwit = raw_tx.len() > offset + 2
            && raw_tx[offset] == 0x00
            && raw_tx[offset + 1] == 0x01;

        if is_segwit {
            offset += 2;
        }

        // Input count (varint)
        let (input_count, varint_size) = read_varint(&raw_tx[offset..])?;
        offset += varint_size;

        // Skip inputs
        for _ in 0..input_count {
            // Previous output (32 + 4 bytes)
            offset += 36;
            if offset > raw_tx.len() {
                return Err(ProgramError::InvalidInstructionData);
            }

            // Script length (varint)
            let (script_len, varint_size) = read_varint(&raw_tx[offset..])?;
            offset += varint_size + script_len as usize + 4; // script + sequence

            if offset > raw_tx.len() {
                return Err(ProgramError::InvalidInstructionData);
            }
        }

        // Output count (varint)
        let (output_count, varint_size) = read_varint(&raw_tx[offset..])?;
        offset += varint_size;

        // Remember where outputs start
        let outputs_start = offset;

        // Skip outputs to find end
        for _ in 0..output_count {
            offset += 8; // value
            if offset > raw_tx.len() {
                return Err(ProgramError::InvalidInstructionData);
            }

            let (script_len, varint_size) = read_varint(&raw_tx[offset..])?;
            offset += varint_size + script_len as usize;

            if offset > raw_tx.len() {
                return Err(ProgramError::InvalidInstructionData);
            }
        }

        Ok(Self {
            version,
            outputs_data: &raw_tx[outputs_start..offset],
            output_count: output_count as usize,
            is_segwit,
        })
    }

    /// Iterate over outputs
    pub fn outputs(&self) -> OutputIterator<'a> {
        OutputIterator {
            data: self.outputs_data,
            offset: 0,
            remaining: self.output_count,
        }
    }

    /// Find commitment from OP_RETURN output
    pub fn find_commitment(&self) -> Option<[u8; 32]> {
        for output in self.outputs() {
            if output.is_op_return() {
                if let Some(commitment) = output.get_commitment() {
                    return Some(commitment);
                }
            }
        }
        None
    }

    /// Find deposit output (non-OP_RETURN with value > 0)
    pub fn find_deposit_output(&self) -> Option<TxOutput<'a>> {
        self.outputs()
            .find(|output| !output.is_op_return() && output.value > 0)
    }

    /// Find stealth OP_RETURN and parse stealth data
    pub fn find_stealth_op_return(&self) -> Option<StealthOpReturnData> {
        for output in self.outputs() {
            if output.is_stealth_op_return() {
                if let Some(data) = output.get_op_return_data() {
                    if let Ok(stealth_data) = StealthOpReturnData::parse(data) {
                        return Some(stealth_data);
                    }
                }
            }
        }
        None
    }
}

/// Iterator over transaction outputs
pub struct OutputIterator<'a> {
    data: &'a [u8],
    offset: usize,
    remaining: usize,
}

impl<'a> Iterator for OutputIterator<'a> {
    type Item = TxOutput<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 || self.offset + 8 > self.data.len() {
            return None;
        }

        let value = u64::from_le_bytes(
            self.data[self.offset..self.offset + 8].try_into().ok()?
        );
        self.offset += 8;

        let (script_len, varint_size) = read_varint(&self.data[self.offset..]).ok()?;
        self.offset += varint_size;

        let script_end = self.offset + script_len as usize;
        if script_end > self.data.len() {
            return None;
        }

        let script_pubkey = &self.data[self.offset..script_end];
        self.offset = script_end;
        self.remaining -= 1;

        Some(TxOutput { value, script_pubkey })
    }
}

/// Read a Bitcoin varint
fn read_varint(data: &[u8]) -> Result<(u64, usize), ProgramError> {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match data[0] {
        0..=0xfc => Ok((data[0] as u64, 1)),
        0xfd => {
            if data.len() < 3 {
                return Err(ProgramError::InvalidInstructionData);
            }
            Ok((u16::from_le_bytes(data[1..3].try_into().unwrap()) as u64, 3))
        }
        0xfe => {
            if data.len() < 5 {
                return Err(ProgramError::InvalidInstructionData);
            }
            Ok((u32::from_le_bytes(data[1..5].try_into().unwrap()) as u64, 5))
        }
        0xff => {
            if data.len() < 9 {
                return Err(ProgramError::InvalidInstructionData);
            }
            Ok((u64::from_le_bytes(data[1..9].try_into().unwrap()), 9))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_varint() {
        assert_eq!(read_varint(&[0x00]).unwrap(), (0, 1));
        assert_eq!(read_varint(&[0xfc]).unwrap(), (252, 1));
        assert_eq!(read_varint(&[0xfd, 0x00, 0x01]).unwrap(), (256, 3));
    }

    #[test]
    fn test_op_return_detection() {
        let mut script = vec![0x6a, 0x20]; // OP_RETURN + push 32 bytes
        script.extend_from_slice(&[0xAB; 32]);

        let output = TxOutput {
            value: 0,
            script_pubkey: &script,
        };
        assert!(output.is_op_return());
        assert!(output.get_commitment().is_some());
    }
}
