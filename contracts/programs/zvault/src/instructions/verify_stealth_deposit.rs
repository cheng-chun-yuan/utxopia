//! Verify Stealth Deposit instruction (Pinocchio)
//!
//! npk-based deposit flow:
//! 1. User generates npk client-side, sends BTC with OP_RETURN(ephemeralPub || npk)
//! 2. Backend detects deposit, sweeps UTXO to pool wallet
//! 3. Backend calls btc-light-client's verify_transaction to create VerifiedTransaction PDA
//! 4. Backend calls this instruction with npk (amount extracted on-chain from raw tx)
//!
//! This instruction:
//! - Checks VerifiedTransaction PDA exists (btc-light-client already verified SPV)
//! - Verifies sufficient confirmations via light client tip height
//! - Extracts deposit amount trustlessly from the SPV-verified raw transaction
//! - Computes commitment ON-CHAIN: Poseidon(npk, ZBTC_TOKEN_ID, amount)
//! - Inserts commitment into Merkle tree
//! - Creates unified StealthAnnouncement (type=0, plaintext amount) with PDA ["stealth", txid]
//! - Mints zBTC to pool vault
//!
//! Instruction Data (108 bytes, fixed):
//! - [0-31]   txid              (32 bytes) - Sweep tx ID (internal byte order)
//! - [32-39]  block_height      (8 bytes)  - Block containing tx (cross-check)
//! - [40-43]  tx_size           (4 bytes)  - Raw tx size in ChadBuffer
//! - [44-75]  ephemeral_pub     (32 bytes) - Ed25519
//! - [76-107] npk               (32 bytes) - Note public key

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::ZVaultError;
use crate::state::{
    CommitmentTree, PoolState, StealthAnnouncement,
    VerifiedTransactionView, light_client_tip_height,
    ANNOUNCEMENT_TYPE_DEPOSIT,
};
use crate::utils::crypto::compute_deposit_commitment;
use crate::utils::bitcoin::{compute_tx_hash, ParsedTransaction};
use crate::utils::chadbuffer::read_transaction_from_buffer;
use crate::utils::{
    mint_zbtc, validate_program_owner, validate_system_program, validate_token_2022_owner,
    validate_token_program_key, validate_account_writable,
};

/// Required confirmations for deposits
#[cfg(feature = "devnet")]
pub const DEMO_REQUIRED_CONFIRMATIONS: u64 = 1;

#[cfg(not(feature = "devnet"))]
pub const DEMO_REQUIRED_CONFIRMATIONS: u64 = 6;

/// Instruction data for verify_stealth_deposit
///
/// The commitment is computed ON-CHAIN: Poseidon(npk, ZBTC_TOKEN_ID, amount)
/// Amount is extracted trustlessly from the SPV-verified raw transaction — no caller input needed.
pub struct VerifyStealthDepositData {
    pub txid: [u8; 32],
    pub block_height: u64,
    pub tx_size: u32,
    pub ephemeral_pub: [u8; 32],
    pub npk: [u8; 32],
}

impl VerifyStealthDepositData {
    pub const HEADER_SIZE: usize = 32 + 8 + 4 + 32 + 32; // 108 bytes

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::HEADER_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut txid = [0u8; 32];
        txid.copy_from_slice(&data[0..32]);

        let block_height = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let tx_size = u32::from_le_bytes(data[40..44].try_into().unwrap());

        let mut ephemeral_pub = [0u8; 32];
        ephemeral_pub.copy_from_slice(&data[44..76]);

        let mut npk = [0u8; 32];
        npk.copy_from_slice(&data[76..108]);

        Ok(Self {
            txid,
            block_height,
            tx_size,
            ephemeral_pub,
            npk,
        })
    }
}

/// Verify an npk-based stealth deposit using VerifiedTransaction PDA
///
/// Computes commitment on-chain, inserts into Merkle tree, creates unified StealthAnnouncement.
///
/// # Accounts
/// 0.  `[writable]` Pool state
/// 1.  `[]` VerifiedTransaction PDA (owned by btc-light-client)
/// 2.  `[]` Light client (owned by btc-light-client, for confirmation count)
/// 3.  `[writable]` Commitment tree
/// 4.  `[writable]` Stealth announcement (PDA to be created, seeded by ["stealth", txid])
/// 5.  `[]` Transaction buffer (ChadBuffer)
/// 6.  `[signer]` Authority (pool authority, pays for storage)
/// 7.  `[]` System program
/// 8.  `[writable]` zBTC mint
/// 9.  `[writable]` Pool vault token account
/// 10. `[]` Token-2022 program
///
/// # Instruction data
/// - VerifyStealthDepositData (108 bytes, fixed — no trailing merkle proof)
pub fn process_verify_stealth_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 11 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let verified_tx_info = &accounts[1];
    let light_client_info = &accounts[2];
    let commitment_tree_info = &accounts[3];
    let stealth_announcement_info = &accounts[4];
    let tx_buffer_info = &accounts[5];
    let authority = &accounts[6];
    let system_program = &accounts[7];
    let zbtc_mint = &accounts[8];
    let pool_vault = &accounts[9];
    let token_program = &accounts[10];

    // Parse instruction data (no trailing merkle proof)
    let ix_data = VerifyStealthDepositData::from_bytes(data)?;

    // Validate account owners
    validate_program_owner(pool_state_info, program_id)?;
    // VerifiedTransaction and Light client are owned by btc-light-client program
    let btc_lc_id: &Pubkey = unsafe {
        &*(&crate::constants::BTC_LIGHT_CLIENT_PROGRAM_ID as *const [u8; 32] as *const Pubkey)
    };
    validate_program_owner(verified_tx_info, btc_lc_id)?;
    validate_program_owner(light_client_info, btc_lc_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    validate_token_2022_owner(zbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;
    validate_system_program(system_program)?;

    // SECURITY: Validate writable accounts
    validate_account_writable(pool_state_info)?;
    validate_account_writable(commitment_tree_info)?;
    validate_account_writable(stealth_announcement_info)?;
    validate_account_writable(zbtc_mint)?;
    validate_account_writable(pool_vault)?;

    // Authority must be signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate authority matches pool and get bump + bounds
    let (pool_bump, min_deposit, max_deposit) = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if pool.is_paused() {
            return Err(ZVaultError::PoolPaused.into());
        }

        if authority.key().as_ref() != pool.authority {
            return Err(ZVaultError::Unauthorized.into());
        }

        (pool.bump, pool.min_deposit(), pool.max_deposit())
    };

    // --- VerifiedTransaction PDA check ---
    // Parse the VerifiedTransaction PDA and verify txid matches
    {
        let vt_data = verified_tx_info.try_borrow_data()?;
        let vt = VerifiedTransactionView::from_bytes(&vt_data)?;

        // Verify txid matches (both in internal byte order)
        if *vt.txid() != ix_data.txid {
            return Err(ZVaultError::InvalidSpvProof.into());
        }

        // Cross-check block height
        if vt.block_height() as u64 != ix_data.block_height {
            return Err(ZVaultError::InvalidBlockHeader.into());
        }
    }

    // Verify sufficient confirmations via light client tip height
    {
        let lc_data = light_client_info.try_borrow_data()?;
        let tip = light_client_tip_height(&lc_data)?;
        let confirmations = if ix_data.block_height > tip {
            0
        } else {
            tip - ix_data.block_height + 1
        };
        if confirmations < DEMO_REQUIRED_CONFIRMATIONS {
            return Err(ZVaultError::InsufficientConfirmations.into());
        }
    }

    // Read raw transaction from ChadBuffer account
    let buffer_data = tx_buffer_info
        .try_borrow_data()
        .map_err(|_| ZVaultError::InvalidBlockHeader)?;

    let raw_tx = read_transaction_from_buffer(&buffer_data, ix_data.tx_size as usize)?;

    // Verify transaction hash matches txid
    // Note: ix_data.txid is in internal byte order (raw double_sha256 output)
    let computed_hash = compute_tx_hash(raw_tx);

    if computed_hash != ix_data.txid {
        return Err(ZVaultError::InvalidSpvProof.into());
    }

    // Parse raw transaction and extract deposit amount trustlessly
    let parsed_tx = ParsedTransaction::parse(raw_tx)
        .map_err(|_| ZVaultError::InvalidSpvProof)?;
    let deposit_output = parsed_tx.find_deposit_output()
        .ok_or(ZVaultError::InvalidSpvProof)?;
    let amount_sats = deposit_output.value;

    // Validate extracted amount is within bounds
    if amount_sats < min_deposit {
        return Err(ZVaultError::AmountTooSmall.into());
    }
    if amount_sats > max_deposit {
        return Err(ZVaultError::AmountTooLarge.into());
    }

    // Derive stealth announcement PDA: ["stealth", txid]
    let (expected_stealth_pda, stealth_bump) = pinocchio::pubkey::find_program_address(
        &[StealthAnnouncement::SEED, &ix_data.txid],
        program_id,
    );

    if stealth_announcement_info.key() != &expected_stealth_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create stealth announcement account (90 bytes instead of 200)
    let stealth_bump_bytes = [stealth_bump];
    let stealth_signer_seeds: [Seed; 3] = [
        Seed::from(StealthAnnouncement::SEED),
        Seed::from(ix_data.txid.as_slice()),
        Seed::from(&stealth_bump_bytes),
    ];
    let stealth_signer = [Signer::from(&stealth_signer_seeds)];

    CreateAccount {
        from: authority,
        to: stealth_announcement_info,
        lamports: Rent::get()?.minimum_balance(StealthAnnouncement::SIZE),
        space: StealthAnnouncement::SIZE as u64,
        owner: program_id,
    }.invoke_signed(&stealth_signer)?;

    // Compute commitment ON-CHAIN: Poseidon(npk, ZBTC_TOKEN_ID, amount)
    let commitment = compute_deposit_commitment(&ix_data.npk, amount_sats)?;

    // Insert commitment into Merkle tree
    let leaf_index = {
        let mut tree_data = commitment_tree_info.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if !tree.has_capacity() {
            return Err(ZVaultError::TreeFull.into());
        }

        tree.insert_leaf(&commitment)?
    };

    let clock = Clock::get()?;

    // Record the deposit as a unified StealthAnnouncement (type=0, plaintext amount)
    {
        let mut ann_data = stealth_announcement_info.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.announcement_type = ANNOUNCEMENT_TYPE_DEPOSIT;
        announcement.ephemeral_pub = ix_data.ephemeral_pub;
        announcement.set_amount_sats(amount_sats); // plaintext for deposits
        announcement.commitment = commitment;
        announcement.set_leaf_index(leaf_index);
        announcement.set_created_at(clock.unix_timestamp);
    }

    // Mint zBTC to pool vault
    let pool_bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &pool_bump_bytes];

    mint_zbtc(
        token_program,
        zbtc_mint,
        pool_vault,
        pool_state_info,
        amount_sats,
        pool_signer_seeds,
    )?;

    // Update pool statistics
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        pool.increment_deposit_count()?;
        pool.add_minted(amount_sats)?;
        pool.add_shielded(amount_sats)?;
        pool.set_last_update(clock.unix_timestamp);
    }

    crate::debug_msg!("npk-based deposit verified and minted");

    Ok(())
}
