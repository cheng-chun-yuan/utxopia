//! Verify Stealth Deposit instruction (Pinocchio)
//!
//! Trustless npk-based deposit flow:
//! 1. User generates npk client-side, sends BTC with OP_RETURN(ephemeralPub || npk)
//! 2. Backend detects deposit, sweeps UTXO to pool wallet
//! 3. Backend calls btc-light-client's verify_transaction to create VerifiedTransaction PDA
//! 4. Backend uploads BOTH sweep TX and deposit TX to ChadBuffer accounts
//! 5. Backend calls this instruction — npk + ephemeral_pub extracted ON-CHAIN from deposit TX
//!
//! This instruction:
//! - Checks VerifiedTransaction PDA exists (btc-light-client already verified SPV for sweep TX)
//! - Verifies sufficient confirmations via light client tip height
//! - Reads deposit TX from its ChadBuffer, extracts npk + ephemeral_pub from OP_RETURN
//! - Verifies sweep TX has an input spending from the deposit TX (proves linkage)
//! - Extracts deposit amount trustlessly from the SPV-verified sweep raw transaction
//! - Computes commitment ON-CHAIN: Poseidon(npk, ZBTC_TOKEN_ID, amount)
//! - Inserts commitment into Merkle tree
//! - Creates unified StealthAnnouncement (type=0, plaintext amount) with PDA ["stealth", sweep_txid]
//! - Mints zBTC to pool vault
//!
//! Instruction Data (80 bytes, fixed):
//! - [0-31]   sweep_txid        (32 bytes) - Sweep tx ID (internal byte order)
//! - [32-39]  block_height      (8 bytes)  - Block containing sweep tx (cross-check)
//! - [40-43]  sweep_tx_size     (4 bytes)  - Raw sweep tx size in ChadBuffer
//! - [44-47]  deposit_tx_size   (4 bytes)  - Raw deposit tx size in ChadBuffer
//! - [48-79]  deposit_txid      (32 bytes) - Deposit tx ID (internal byte order)

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::AegisError;
use crate::state::{
    CommitmentTree, PoolState, StealthAnnouncement,
    VerifiedTransactionView, light_client_tip_height,
    ANNOUNCEMENT_TYPE_DEPOSIT,
};
use crate::utils::crypto::compute_deposit_commitment;
use crate::utils::bitcoin::{compute_tx_hash, DepositOpReturn, ParsedTransaction};
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

/// Instruction data for verify_stealth_deposit (trustless npk extraction)
///
/// The commitment is computed ON-CHAIN: Poseidon(npk, ZBTC_TOKEN_ID, amount)
/// npk + ephemeral_pub are extracted ON-CHAIN from the deposit TX's OP_RETURN.
/// Amount is extracted from the SPV-verified sweep TX.
pub struct VerifyStealthDepositData {
    pub sweep_txid: [u8; 32],
    pub block_height: u64,
    pub sweep_tx_size: u32,
    pub deposit_tx_size: u32,
    pub deposit_txid: [u8; 32],
}

impl VerifyStealthDepositData {
    pub const HEADER_SIZE: usize = 32 + 8 + 4 + 4 + 32; // 80 bytes

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::HEADER_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut sweep_txid = [0u8; 32];
        sweep_txid.copy_from_slice(&data[0..32]);

        let block_height = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let sweep_tx_size = u32::from_le_bytes(data[40..44].try_into().unwrap());
        let deposit_tx_size = u32::from_le_bytes(data[44..48].try_into().unwrap());

        let mut deposit_txid = [0u8; 32];
        deposit_txid.copy_from_slice(&data[48..80]);

        Ok(Self {
            sweep_txid,
            block_height,
            sweep_tx_size,
            deposit_tx_size,
            deposit_txid,
        })
    }
}

/// Verify an npk-based stealth deposit using VerifiedTransaction PDA
///
/// Trustlessly extracts npk + ephemeral_pub from the deposit TX's OP_RETURN.
/// Verifies the sweep TX spends from the deposit TX (input linkage).
/// Computes commitment on-chain, inserts into Merkle tree, creates unified StealthAnnouncement.
///
/// # Accounts
/// 0.  `[writable]` Pool state
/// 1.  `[]` VerifiedTransaction PDA (owned by btc-light-client)
/// 2.  `[]` Light client (owned by btc-light-client, for confirmation count)
/// 3.  `[writable]` Commitment tree
/// 4.  `[writable]` Stealth announcement (PDA to be created, seeded by ["stealth", sweep_txid])
/// 5.  `[]` Sweep TX buffer (ChadBuffer)
/// 6.  `[signer]` Authority (pool authority, pays for storage)
/// 7.  `[]` System program
/// 8.  `[writable]` zBTC mint
/// 9.  `[writable]` Pool vault token account
/// 10. `[]` Token-2022 program
/// 11. `[]` Deposit TX buffer (ChadBuffer)
///
/// # Instruction data
/// - VerifyStealthDepositData (80 bytes, fixed)
pub fn process_verify_stealth_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 12 {
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
    let deposit_tx_buffer_info = &accounts[11];

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
            return Err(AegisError::PoolPaused.into());
        }

        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }

        (pool.bump, pool.min_deposit(), pool.max_deposit())
    };

    // --- VerifiedTransaction PDA check ---
    // Parse the VerifiedTransaction PDA and verify sweep txid matches
    {
        let vt_data = verified_tx_info.try_borrow_data()?;
        let vt = VerifiedTransactionView::from_bytes(&vt_data)?;

        // Verify txid matches (both in internal byte order)
        if *vt.txid() != ix_data.sweep_txid {
            return Err(AegisError::InvalidSpvProof.into());
        }

        // Cross-check block height
        if vt.block_height() as u64 != ix_data.block_height {
            return Err(AegisError::InvalidBlockHeader.into());
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
            return Err(AegisError::InsufficientConfirmations.into());
        }
    }

    // --- Read and verify sweep TX from ChadBuffer ---
    let sweep_buffer_data = tx_buffer_info
        .try_borrow_data()
        .map_err(|_| AegisError::InvalidBlockHeader)?;

    let sweep_raw_tx = read_transaction_from_buffer(&sweep_buffer_data, ix_data.sweep_tx_size as usize)?;

    // Verify sweep transaction hash matches sweep_txid
    let computed_sweep_hash = compute_tx_hash(sweep_raw_tx);
    if computed_sweep_hash != ix_data.sweep_txid {
        return Err(AegisError::InvalidSpvProof.into());
    }

    // Parse sweep TX and extract deposit amount
    let sweep_parsed = ParsedTransaction::parse(sweep_raw_tx)
        .map_err(|_| AegisError::InvalidSpvProof)?;

    // --- Read and verify deposit TX from ChadBuffer ---
    let deposit_buffer_data = deposit_tx_buffer_info
        .try_borrow_data()
        .map_err(|_| AegisError::InvalidBlockHeader)?;

    let deposit_raw_tx = read_transaction_from_buffer(&deposit_buffer_data, ix_data.deposit_tx_size as usize)?;

    // Verify deposit transaction hash matches deposit_txid
    let computed_deposit_hash = compute_tx_hash(deposit_raw_tx);
    if computed_deposit_hash != ix_data.deposit_txid {
        return Err(AegisError::InvalidSpvProof.into());
    }

    // Parse deposit TX
    let deposit_parsed = ParsedTransaction::parse(deposit_raw_tx)
        .map_err(|_| AegisError::InvalidSpvProof)?;

    // --- Verify sweep TX spends from deposit TX (input linkage) ---
    // This proves the chain: deposit TX -> sweep TX (SPV-verified)
    if !sweep_parsed.find_input_with_prev_txid(&ix_data.deposit_txid) {
        return Err(AegisError::InvalidSpvProof.into());
    }

    // --- Extract npk + ephemeral_pub from deposit TX OP_RETURN ---
    let DepositOpReturn { ephemeral_pub, npk } = deposit_parsed
        .find_deposit_op_return()
        .ok_or(AegisError::InvalidStealthOpReturn)?;

    // Extract deposit amount from sweep TX's deposit output
    let deposit_output = sweep_parsed.find_deposit_output()
        .ok_or(AegisError::InvalidSpvProof)?;
    let amount_sats = deposit_output.value;

    // Validate extracted amount is within bounds
    if amount_sats < min_deposit {
        return Err(AegisError::AmountTooSmall.into());
    }
    if amount_sats > max_deposit {
        return Err(AegisError::AmountTooLarge.into());
    }

    // Derive stealth announcement PDA: ["stealth", sweep_txid]
    let (expected_stealth_pda, stealth_bump) = pinocchio::pubkey::find_program_address(
        &[StealthAnnouncement::SEED, &ix_data.sweep_txid],
        program_id,
    );

    if stealth_announcement_info.key() != &expected_stealth_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create stealth announcement account (90 bytes instead of 200)
    let stealth_bump_bytes = [stealth_bump];
    let stealth_signer_seeds: [Seed; 3] = [
        Seed::from(StealthAnnouncement::SEED),
        Seed::from(ix_data.sweep_txid.as_slice()),
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
    // npk is trustlessly extracted from the deposit TX's OP_RETURN
    let commitment = compute_deposit_commitment(&npk, amount_sats)?;

    // Insert commitment into Merkle tree
    let leaf_index = {
        let mut tree_data = commitment_tree_info.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if !tree.has_capacity() {
            return Err(AegisError::TreeFull.into());
        }

        tree.insert_leaf(&commitment)?
    };

    let clock = Clock::get()?;

    // Record the deposit as a unified StealthAnnouncement (type=0, plaintext amount)
    {
        let mut ann_data = stealth_announcement_info.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.announcement_type = ANNOUNCEMENT_TYPE_DEPOSIT;
        announcement.ephemeral_pub = ephemeral_pub;
        announcement.set_amount_sats(amount_sats); // plaintext for deposits
        announcement.commitment = commitment;
        announcement.set_leaf_index(leaf_index);
    }

    // Emit leaf inserted event (commitment + timestamp for indexer)
    crate::utils::events::emit_leaf_inserted(&commitment, clock.unix_timestamp);

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
