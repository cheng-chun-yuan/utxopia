//! Aegis - Privacy-Preserving BTC to Solana Bridge (Pinocchio)
//!
//! SHIELDED-ONLY ARCHITECTURE (JoinSplit Model):
//! - zkBTC exists only as commitments in Merkle tree
//! - Users never hold public zkBTC tokens
//! - Amount revealed ONLY at BTC withdrawal
//! - All deposits use stealth announcements for recipient discovery
//! - All transfers use JoinSplit(N,M) proofs with EdDSA-Poseidon signatures
//!
//! ## Privacy Guarantee
//!
//! | Operation     | Amount Visible? |
//! |---------------|-----------------|
//! | Deposit       | No (in commitment) |
//! | Transact      | No (JoinSplit) |
//! | Withdraw      | Yes (unavoidable) |
//!
//! ## Core Flow
//!
//! ```text
//! BTC Deposit → Verify SPV → Stealth Announcement → Mint to Pool → Commitment in Tree
//!                                                                          ↓
//!                                    JoinSplit Transact (private, ZK proof)
//!                                                                          ↓
//!                              Withdraw → ZK Proof → Burn from Pool → BTC
//! ```

use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod utils;

/// Program ID (update after deployment)
pub const ID: Pubkey = [
    0x0a, 0x6a, 0x3c, 0x1e, 0x87, 0x32, 0x1a, 0x5c,
    0x7f, 0x4b, 0x2d, 0x9e, 0x8a, 0x6c, 0x3f, 0x1b,
    0x5d, 0x2a, 0x8e, 0x4c, 0x7b, 0x3a, 0x1f, 0x6d,
    0x9c, 0x5e, 0x2b, 0x8f, 0x4a, 0x7d, 0x3c, 0x1e,
];

/// Instruction discriminators
pub mod instruction {
    // Core operations
    pub const INITIALIZE: u8 = 0;
    pub const VERIFY_STEALTH_DEPOSIT: u8 = 1;
    pub const MARK_PROCESSING: u8 = 2;
    pub const CANCEL_REDEMPTION: u8 = 3;
    pub const REQUEST_REDEMPTION: u8 = 5;
    pub const COMPLETE_REDEMPTION: u8 = 6;
    pub const SET_PAUSED: u8 = 7;

    // VK Registry (admin)
    pub const INIT_VK_REGISTRY: u8 = 11;
    pub const UPDATE_VK_REGISTRY: u8 = 12;

    // Demo/testing (admin only) - DISABLED IN PRODUCTION
    #[cfg(feature = "devnet")]
    pub const ADD_DEMO_STEALTH: u8 = 13;

    // JoinSplit (Railgun-aligned)
    pub const TRANSACT: u8 = 14;

    // Public unshield (zkBTC → SPL token)
    pub const UNSHIELD: u8 = 15;

    // Redeem: JoinSplit N→M with BTC redemption (last output → RedemptionRequest)
    pub const REDEEM: u8 = 16;

    // Public redeem: burn SPL zkBTC → RedemptionRequest (no ZK proof)
    pub const PUBLIC_REDEEM: u8 = 17;

    // Timelocked pool parameter updates (enabled in all builds)
    pub const PROPOSE_POOL_UPDATE: u8 = 21;
    pub const EXECUTE_POOL_UPDATE: u8 = 22;
    pub const CANCEL_POOL_UPDATE: u8 = 23;

    // OP_RETURN-free deposit flow
    pub const REGISTER_DEPOSIT_INTENT: u8 = 24;
    pub const VERIFY_DEPOSIT_V2: u8 = 25;

    // Fee management
    pub const CLAIM_FEES: u8 = 26;

    // Pool config (admin)
    pub const SET_POOL_CONFIG: u8 = 27;

    // Multi-token instructions (fresh deploy: reuse freed slots)
    pub const REGISTER_TOKEN: u8 = 28;
    pub const SHIELD: u8 = 29;
    pub const UNSHIELD_V2: u8 = 30;
    pub const UPDATE_TOKEN_CONFIG: u8 = 31;
    pub const CLAIM_FEES_V2: u8 = 32;
}

entrypoint!(process_instruction);

/// Main entrypoint - routes to instruction handlers
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        instruction::INITIALIZE => {
            instructions::process_initialize(program_id, accounts, data)
        }
        instruction::VERIFY_STEALTH_DEPOSIT => {
            instructions::process_verify_stealth_deposit(program_id, accounts, data)
        }
        instruction::MARK_PROCESSING => {
            instructions::process_mark_processing(program_id, accounts, data)
        }
        instruction::CANCEL_REDEMPTION => {
            instructions::process_cancel_redemption(program_id, accounts, data)
        }
        instruction::REQUEST_REDEMPTION => {
            instructions::process_request_redemption(program_id, accounts, data)
        }
        instruction::COMPLETE_REDEMPTION => {
            instructions::process_complete_redemption(program_id, accounts, data)
        }
        instruction::SET_PAUSED => {
            process_set_paused(program_id, accounts, data)
        }
        // Demo/testing - DISABLED IN PRODUCTION
        #[cfg(feature = "devnet")]
        instruction::ADD_DEMO_STEALTH => {
            instructions::process_add_demo_stealth(program_id, accounts, data)
        }
        // VK Registry
        instruction::INIT_VK_REGISTRY => {
            instructions::process_init_vk_registry(program_id, accounts, data)
        }
        instruction::UPDATE_VK_REGISTRY => {
            instructions::process_update_vk_registry(program_id, accounts, data)
        }
        // JoinSplit (Railgun-aligned)
        instruction::TRANSACT => {
            instructions::process_transact(program_id, accounts, data)
        }
        // Public unshield
        instruction::UNSHIELD => {
            instructions::process_unshield(program_id, accounts, data)
        }
        // Redeem: JoinSplit + BTC redemption
        instruction::REDEEM => {
            instructions::process_redeem(program_id, accounts, data)
        }
        // Public redeem: burn SPL → BTC redemption
        instruction::PUBLIC_REDEEM => {
            instructions::process_public_redeem(program_id, accounts, data)
        }
        // Admin: close PDA (removed — use fresh deploy instead)
        // Timelocked pool parameter updates
        instruction::PROPOSE_POOL_UPDATE => {
            instructions::process_propose_pool_update(program_id, accounts, data)
        }
        instruction::EXECUTE_POOL_UPDATE => {
            instructions::process_execute_pool_update(program_id, accounts, data)
        }
        instruction::CANCEL_POOL_UPDATE => {
            instructions::process_cancel_pool_update(program_id, accounts, data)
        }
        // OP_RETURN-free deposit flow
        instruction::REGISTER_DEPOSIT_INTENT => {
            instructions::process_register_deposit_intent(program_id, accounts, data)
        }
        instruction::VERIFY_DEPOSIT_V2 => {
            instructions::process_verify_deposit_v2(program_id, accounts, data)
        }
        // Fee management
        instruction::CLAIM_FEES => {
            instructions::process_claim_fees(program_id, accounts, data)
        }
        // Pool config (admin)
        instruction::SET_POOL_CONFIG => {
            instructions::process_set_pool_config(program_id, accounts, data)
        }
        // Multi-token: register new token
        instruction::REGISTER_TOKEN => {
            instructions::process_register_token(program_id, accounts, data)
        }
        // Multi-token: shield SPL token
        instruction::SHIELD => {
            instructions::process_shield(program_id, accounts, data)
        }
        // Multi-token: unshield SPL token (ZK proof)
        instruction::UNSHIELD_V2 => {
            instructions::process_unshield_v2(program_id, accounts, data)
        }
        // Multi-token: update token config (admin)
        instruction::UPDATE_TOKEN_CONFIG => {
            instructions::process_update_token_config(program_id, accounts, data)
        }
        // Multi-token: claim per-token fees (admin)
        instruction::CLAIM_FEES_V2 => {
            instructions::process_claim_fees_v2(program_id, accounts, data)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Set pool paused state (admin only)
fn process_set_paused(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    use crate::error::AegisError;
    use crate::state::PoolState;
    use crate::utils::validate_program_owner;
    use pinocchio::sysvars::{clock::Clock, Sysvar};

    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state = &accounts[0];
    let authority = &accounts[1];

    validate_program_owner(pool_state, program_id)?;

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let paused = data[0] != 0;

    {
        let mut pool_data = pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }

        pool.set_paused(paused);
        let ts = Clock::get()?.unix_timestamp;
        pool.set_last_update(ts);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discriminators_unique() {
        let discriminators: &[u8] = &[
            instruction::INITIALIZE,
            instruction::VERIFY_STEALTH_DEPOSIT,
            instruction::MARK_PROCESSING,
            instruction::CANCEL_REDEMPTION,
            instruction::REQUEST_REDEMPTION,
            instruction::COMPLETE_REDEMPTION,
            instruction::SET_PAUSED,
            instruction::INIT_VK_REGISTRY,
            instruction::UPDATE_VK_REGISTRY,
            instruction::TRANSACT,
            instruction::UNSHIELD,
            instruction::REDEEM,
            instruction::PUBLIC_REDEEM,
            #[cfg(feature = "devnet")]
            instruction::ADD_DEMO_STEALTH,
            instruction::PROPOSE_POOL_UPDATE,
            instruction::EXECUTE_POOL_UPDATE,
            instruction::CANCEL_POOL_UPDATE,
            instruction::REGISTER_DEPOSIT_INTENT,
            instruction::VERIFY_DEPOSIT_V2,
            instruction::CLAIM_FEES,
            instruction::SET_POOL_CONFIG,
        ];

        for (i, &d1) in discriminators.iter().enumerate() {
            for (j, &d2) in discriminators.iter().enumerate() {
                if i != j {
                    assert_ne!(d1, d2, "Duplicate at {} and {}", i, j);
                }
            }
        }
    }

    #[test]
    fn test_account_discriminators_unique() {
        use crate::state::pool::POOL_STATE_DISCRIMINATOR;
        use crate::state::nullifier::NULLIFIER_RECORD_DISCRIMINATOR;
        use crate::state::redemption::REDEMPTION_REQUEST_DISCRIMINATOR;
        use crate::state::commitment_tree::COMMITMENT_TREE_DISCRIMINATOR;
        use crate::state::deposit_receipt::DEPOSIT_RECEIPT_DISCRIMINATOR;
        use crate::state::deposit_intent::DEPOSIT_INTENT_DISCRIMINATOR;
        use crate::state::completion_receipt::COMPLETION_RECEIPT_DISCRIMINATOR;
        use crate::state::utxo::UTXO_RECORD_DISCRIMINATOR;
        use crate::state::vk_registry::VK_REGISTRY_DISCRIMINATOR;
        use crate::state::pool_config::POOL_CONFIG_DISCRIMINATOR;

        // All Aegis-owned account discriminators must be unique
        let discs: &[u8] = &[
            POOL_STATE_DISCRIMINATOR,           // 0x01
            NULLIFIER_RECORD_DISCRIMINATOR,     // 0x03
            REDEMPTION_REQUEST_DISCRIMINATOR,   // 0x04
            COMMITMENT_TREE_DISCRIMINATOR,      // 0x05
            DEPOSIT_RECEIPT_DISCRIMINATOR,       // 0x06
            DEPOSIT_INTENT_DISCRIMINATOR,        // 0x07
            COMPLETION_RECEIPT_DISCRIMINATOR,    // 0x08
            UTXO_RECORD_DISCRIMINATOR,          // 0x09
            POOL_CONFIG_DISCRIMINATOR,          // 0x0A
            VK_REGISTRY_DISCRIMINATOR,          // 0x14
        ];

        for (i, &d1) in discs.iter().enumerate() {
            for (j, &d2) in discs.iter().enumerate() {
                if i != j {
                    assert_ne!(d1, d2, "Duplicate account discriminator at {} (0x{:02x}) and {} (0x{:02x})", i, d1, j, d2);
                }
            }
        }
    }

    #[test]
    fn test_utxo_discriminator_value() {
        use crate::state::utxo::UTXO_RECORD_DISCRIMINATOR;
        assert_eq!(UTXO_RECORD_DISCRIMINATOR, 0x09);
    }
}
