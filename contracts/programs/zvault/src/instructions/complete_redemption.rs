//! Complete redemption instruction — SPV-verify BTC delivery, burn zBTC, close PDA
//!
//! ESCROW-BASED ARCHITECTURE:
//! - Authority provides SPV proof that BTC was delivered to the requested address
//! - On success: burn zBTC from pool vault, close RedemptionRequest PDA
//! - NullifierRecord is NOT closed — it must persist forever to prevent double-spend

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::ZVaultError;
use crate::state::{
    BitcoinLightClient, BlockHeader, PoolState, RedemptionRequest, RedemptionStatus, TxMerkleProof,
};
use crate::utils::bitcoin::compute_tx_hash;
use crate::utils::chadbuffer::read_transaction_from_buffer;
use crate::utils::{
    burn_zbtc_signed, close_account_securely, validate_account_writable, validate_program_owner,
    validate_token_2022_owner, validate_token_program_key,
};

/// Required BTC confirmations before completing redemption
const REQUIRED_CONFIRMATIONS: u64 = 1;

/// Complete redemption instruction data
///
/// Layout:
/// - btc_txid:      32 bytes - BTC transaction ID (internal byte order)
/// - block_height:  8 bytes  - Block containing the tx
/// - tx_size:       4 bytes  - Raw tx size in ChadBuffer
/// - merkle_proof:  variable - SPV merkle siblings
pub struct CompleteRedemptionData {
    pub btc_txid: [u8; 32],
    pub block_height: u64,
    pub tx_size: u32,
}

impl CompleteRedemptionData {
    pub const HEADER_SIZE: usize = 32 + 8 + 4; // 44 bytes

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::HEADER_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut btc_txid = [0u8; 32];
        btc_txid.copy_from_slice(&data[0..32]);

        let block_height = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let tx_size = u32::from_le_bytes(data[40..44].try_into().unwrap());

        Ok(Self {
            btc_txid,
            block_height,
            tx_size,
        })
    }
}

/// Process complete redemption with SPV verification
///
/// # Accounts
/// 0.  `[writable]` Pool state
/// 1.  `[writable]` Redemption request
/// 2.  `[signer]`   Authority (pool authority)
/// 3.  `[]`         Rent recipient (receives lamports when PDA is closed)
/// 4.  `[]`         Light client (btc-relay)
/// 5.  `[]`         Block header (btc-relay)
/// 6.  `[]`         Transaction buffer (ChadBuffer)
/// 7.  `[writable]` zBTC mint
/// 8.  `[writable]` Pool vault
/// 9.  `[]`         Token-2022 program
pub fn process_complete_redemption(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let redemption_info = &accounts[1];
    let authority = &accounts[2];
    let rent_recipient = &accounts[3];
    let light_client_info = &accounts[4];
    let block_header_info = &accounts[5];
    let tx_buffer_info = &accounts[6];
    let zbtc_mint = &accounts[7];
    let pool_vault = &accounts[8];
    let token_program = &accounts[9];

    // Parse instruction data
    let ix_data = CompleteRedemptionData::from_bytes(data)?;
    let merkle_proof = TxMerkleProof::parse(&data[CompleteRedemptionData::HEADER_SIZE..])?;

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate account owners
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(redemption_info, program_id)?;
    let btc_lc_id: &Pubkey = unsafe {
        &*(&crate::constants::BTC_LIGHT_CLIENT_PROGRAM_ID as *const [u8; 32] as *const Pubkey)
    };
    validate_program_owner(light_client_info, btc_lc_id)?;
    validate_program_owner(block_header_info, btc_lc_id)?;
    validate_token_2022_owner(zbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;

    // Validate writable accounts
    validate_account_writable(pool_state_info)?;
    validate_account_writable(redemption_info)?;
    validate_account_writable(zbtc_mint)?;
    validate_account_writable(pool_vault)?;

    // Validate authority and get pool state
    let (pool_bump, pending_redemptions) = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(ZVaultError::Unauthorized.into());
        }

        (pool.bump, pool.pending_redemptions())
    };

    // Validate redemption state (must be Pending or Processing)
    let amount_sats = {
        let redemption_data = redemption_info.try_borrow_data()?;
        let redemption = RedemptionRequest::from_bytes(&redemption_data)?;

        let status = redemption.get_status();
        if status != RedemptionStatus::Pending && status != RedemptionStatus::Processing {
            return Err(ZVaultError::InvalidRedemptionState.into());
        }

        redemption.amount_sats()
    };

    // --- SPV Verification ---

    // Verify block height matches the stored header
    let block_merkle_root = {
        let header_data = block_header_info.try_borrow_data()?;
        let header = BlockHeader::from_bytes(&header_data)?;

        if header.height() != ix_data.block_height {
            return Err(ZVaultError::InvalidBlockHeader.into());
        }

        header.merkle_root
    };

    // Verify sufficient confirmations
    {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;

        let confirmations = lc.confirmations(ix_data.block_height);
        if confirmations < REQUIRED_CONFIRMATIONS {
            return Err(ZVaultError::InsufficientConfirmations.into());
        }
    }

    // Read raw transaction from ChadBuffer
    let buffer_data = tx_buffer_info
        .try_borrow_data()
        .map_err(|_| ZVaultError::RedemptionSpvFailed)?;
    let raw_tx = read_transaction_from_buffer(&buffer_data, ix_data.tx_size as usize)?;

    // Verify transaction hash matches provided txid
    let computed_hash = compute_tx_hash(raw_tx);
    if computed_hash != ix_data.btc_txid {
        return Err(ZVaultError::RedemptionSpvFailed.into());
    }

    // Verify merkle proof
    if merkle_proof.txid != ix_data.btc_txid {
        return Err(ZVaultError::RedemptionSpvFailed.into());
    }
    if !merkle_proof.verify(&block_merkle_root) {
        return Err(ZVaultError::RedemptionSpvFailed.into());
    }

    // --- Burn zBTC from pool vault ---
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    burn_zbtc_signed(
        token_program,
        zbtc_mint,
        pool_vault,
        pool_state_info,
        amount_sats,
        pool_signer_seeds,
    )?;

    // --- Update pool state ---
    let clock = Clock::get()?;
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        pool.add_burned(amount_sats)?;
        pool.set_pending_redemptions(pending_redemptions.saturating_sub(1));
        pool.set_last_update(clock.unix_timestamp);
    }

    // --- Close RedemptionRequest PDA ---
    close_account_securely(redemption_info, rent_recipient)?;

    Ok(())
}
