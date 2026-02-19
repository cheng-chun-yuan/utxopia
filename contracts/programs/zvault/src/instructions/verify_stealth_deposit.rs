//! Verify Stealth Deposit V2 instruction (Pinocchio)
//!
//! Backend-managed stealth deposit flow for 2-phase BTC deposits:
//! 1. Backend generates ephemeral keypair, derives BTC address
//! 2. User deposits BTC to that address
//! 3. Backend detects, sweeps, and calls this instruction
//!
//! This instruction combines:
//! - SPV verification of the sweep transaction
//! - Stealth announcement creation
//! - zBTC minting to pool vault
//!
//! Key differences from verify_stealth_deposit:
//! - Commitment is pre-computed by backend (not from OP_RETURN)
//! - Ephemeral pubkey provided directly (not parsed from tx)
//! - Authority-gated (only pool authority can call)
//!
//! Instruction Data (84 bytes + merkle proof):
//! - [0-31]   txid              (32 bytes) - Sweep tx ID (reversed)
//! - [32-39]  block_height      (8 bytes)  - Block containing tx
//! - [40-47]  amount_sats       (8 bytes)  - Amount in satoshis
//! - [48-51]  tx_size           (4 bytes)  - Raw tx size in ChadBuffer
//! - [52-83]  ephemeral_pub     (32 bytes) - Ed25519
//! - [84-115] commitment        (32 bytes) - Backend-computed Poseidon2
//! - [116+]   merkle_proof      (variable) - SPV merkle siblings

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
    BitcoinLightClient, BlockHeader, CommitmentTree, DepositRecord,
    PoolState, StealthAnnouncement, TxMerkleProof,
};
use crate::utils::bitcoin::compute_tx_hash;
use crate::utils::chadbuffer::read_transaction_from_buffer;
use crate::utils::{
    mint_zbtc, validate_program_owner, validate_system_program, validate_token_2022_owner,
    validate_token_program_key, validate_account_writable,
};

/// Required confirmations for demo mode (reduced from 6)
pub const DEMO_REQUIRED_CONFIRMATIONS: u64 = 1;

/// Instruction data for verify_stealth_deposit
///
/// The commitment field uses JoinSplit format: Poseidon(npk, token, amount)
/// where npk = Poseidon(MPK, random), token = ZBTC_TOKEN_ID.
/// The backend pre-computes this commitment before calling this instruction.
pub struct VerifyStealthDepositData {
    pub txid: [u8; 32],
    pub block_height: u64,
    pub amount_sats: u64,
    pub tx_size: u32,
    pub ephemeral_pub: [u8; 32],
    pub commitment: [u8; 32],
}

impl VerifyStealthDepositData {
    pub const HEADER_SIZE: usize = 32 + 8 + 8 + 4 + 32 + 32; // 116 bytes

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::HEADER_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut txid = [0u8; 32];
        txid.copy_from_slice(&data[0..32]);

        let block_height = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let amount_sats = u64::from_le_bytes(data[40..48].try_into().unwrap());
        let tx_size = u32::from_le_bytes(data[48..52].try_into().unwrap());

        let mut ephemeral_pub = [0u8; 32];
        ephemeral_pub.copy_from_slice(&data[52..84]);

        let mut commitment = [0u8; 32];
        commitment.copy_from_slice(&data[84..116]);

        Ok(Self {
            txid,
            block_height,
            amount_sats,
            tx_size,
            ephemeral_pub,
            commitment,
        })
    }
}

/// Verify a backend-managed stealth deposit via SPV proof
///
/// Combines SPV verification + stealth announcement + zBTC minting.
///
/// # Accounts
/// 0.  `[writable]` Pool state
/// 1.  `[]` Light client
/// 2.  `[]` Block header (at block_height)
/// 3.  `[writable]` Commitment tree
/// 4.  `[writable]` Deposit record (PDA to be created, seeded by txid)
/// 5.  `[writable]` Stealth announcement (PDA to be created, seeded by ephemeral_pub)
/// 6.  `[]` Transaction buffer (ChadBuffer)
/// 7.  `[signer]` Authority (pool authority, pays for storage)
/// 8.  `[]` System program
/// 9.  `[writable]` zBTC mint
/// 10. `[writable]` Pool vault token account
/// 11. `[]` Token-2022 program
///
/// # Instruction data
/// - Header: VerifyStealthDepositData (117 bytes)
/// - merkle_proof: TxMerkleProof (variable length)
pub fn process_verify_stealth_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 12 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let light_client_info = &accounts[1];
    let block_header_info = &accounts[2];
    let commitment_tree_info = &accounts[3];
    let deposit_record_info = &accounts[4];
    let stealth_announcement_info = &accounts[5];
    let tx_buffer_info = &accounts[6];
    let authority = &accounts[7];
    let system_program = &accounts[8];
    let zbtc_mint = &accounts[9];
    let pool_vault = &accounts[10];
    let token_program = &accounts[11];

    // Parse instruction data
    let ix_data = VerifyStealthDepositData::from_bytes(data)?;
    let merkle_proof = TxMerkleProof::parse(&data[VerifyStealthDepositData::HEADER_SIZE..])?;

    // Validate account owners
    validate_program_owner(pool_state_info, program_id)?;
    // Light client and block header are owned by btc-relay program
    let btc_relay_id: &Pubkey = unsafe {
        &*(&crate::constants::BTC_RELAY_PROGRAM_ID as *const [u8; 32] as *const Pubkey)
    };
    validate_program_owner(light_client_info, btc_relay_id)?;
    validate_program_owner(block_header_info, btc_relay_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    validate_token_2022_owner(zbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;
    validate_system_program(system_program)?;

    // SECURITY: Validate writable accounts
    validate_account_writable(pool_state_info)?;
    validate_account_writable(commitment_tree_info)?;
    validate_account_writable(deposit_record_info)?;
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

    // Validate amount is within bounds
    if ix_data.amount_sats < min_deposit {
        return Err(ZVaultError::AmountTooSmall.into());
    }
    if ix_data.amount_sats > max_deposit {
        return Err(ZVaultError::AmountTooLarge.into());
    }

    // Verify block height matches the stored header
    let merkle_root = {
        let header_data = block_header_info.try_borrow_data()?;
        let header = BlockHeader::from_bytes(&header_data)?;

        if header.height() != ix_data.block_height {
            return Err(ZVaultError::InvalidBlockHeader.into());
        }

        header.merkle_root
    };

    // Verify block has sufficient confirmations (1 for demo mode)
    {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;

        let confirmations = lc.confirmations(ix_data.block_height);
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
    let computed_hash = compute_tx_hash(raw_tx);
    let mut computed_txid = computed_hash;
    computed_txid.reverse(); // txid is reversed hash

    if computed_txid != ix_data.txid {
        return Err(ZVaultError::InvalidSpvProof.into());
    }

    // Verify the merkle proof
    if merkle_proof.txid != ix_data.txid {
        return Err(ZVaultError::InvalidSpvProof.into());
    }
    if !merkle_proof.verify(&merkle_root) {
        return Err(ZVaultError::InvalidSpvProof.into());
    }

    // Derive deposit record PDA
    let (expected_deposit_pda, deposit_bump) = pinocchio::pubkey::find_program_address(
        &[DepositRecord::SEED, &ix_data.txid],
        program_id,
    );

    if deposit_record_info.key() != &expected_deposit_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Derive stealth announcement PDA (seeded by ephemeral_pub, 32 bytes Ed25519)
    let (expected_stealth_pda, stealth_bump) = pinocchio::pubkey::find_program_address(
        &[StealthAnnouncement::SEED, &ix_data.ephemeral_pub],
        program_id,
    );

    if stealth_announcement_info.key() != &expected_stealth_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create deposit record account
    let deposit_bump_bytes = [deposit_bump];
    let deposit_signer_seeds: [Seed; 3] = [
        Seed::from(DepositRecord::SEED),
        Seed::from(ix_data.txid.as_slice()),
        Seed::from(&deposit_bump_bytes),
    ];
    let deposit_signer = [Signer::from(&deposit_signer_seeds)];

    CreateAccount {
        from: authority,
        to: deposit_record_info,
        lamports: Rent::get()?.minimum_balance(DepositRecord::LEN),
        space: DepositRecord::LEN as u64,
        owner: program_id,
    }.invoke_signed(&deposit_signer)?;

    // Create stealth announcement account
    let stealth_bump_bytes = [stealth_bump];
    let stealth_signer_seeds: [Seed; 3] = [
        Seed::from(StealthAnnouncement::SEED),
        Seed::from(&ix_data.ephemeral_pub),
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

    // Insert commitment into Merkle tree
    let leaf_index = {
        let mut tree_data = commitment_tree_info.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if !tree.has_capacity() {
            return Err(ZVaultError::TreeFull.into());
        }

        tree.insert_leaf(&ix_data.commitment)?
    };

    let clock = Clock::get()?;

    // Record the deposit
    {
        let mut deposit_data = deposit_record_info.try_borrow_mut_data()?;
        let deposit = DepositRecord::init(&mut deposit_data)?;

        deposit.commitment = ix_data.commitment;
        deposit.set_amount_sats(ix_data.amount_sats);
        deposit.btc_txid = ix_data.txid;
        deposit.set_block_height(ix_data.block_height);
        deposit.set_leaf_index(leaf_index);
        deposit.depositor.copy_from_slice(authority.key());
        deposit.set_timestamp(clock.unix_timestamp);
        deposit.set_minted(true); // Will be minted immediately
    }

    // Initialize stealth announcement
    {
        let mut ann_data = stealth_announcement_info.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.bump = stealth_bump;
        announcement.ephemeral_pub = ix_data.ephemeral_pub;
        announcement.set_amount_sats(ix_data.amount_sats);
        announcement.commitment = ix_data.commitment;
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
        ix_data.amount_sats,
        pool_signer_seeds,
    )?;

    // Update pool statistics
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        pool.increment_deposit_count()?;
        pool.add_minted(ix_data.amount_sats)?;
        pool.add_shielded(ix_data.amount_sats)?;
        pool.set_last_update(clock.unix_timestamp);
    }

    crate::debug_msg!("Stealth deposit v2 verified and minted");

    Ok(())
}
