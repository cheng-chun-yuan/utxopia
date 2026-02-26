//! Complete redemption instruction — verify BTC delivery via VerifiedTransaction PDA, burn zBTC, close PDA
//!
//! ESCROW-BASED ARCHITECTURE:
//! - Authority provides btc_txid matching a VerifiedTransaction PDA (btc-relay verified SPV)
//! - On-chain: parse raw tx from ChadBuffer, verify output pays correct address/amount
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
    PoolState, RedemptionRequest, RedemptionStatus,
    VerifiedTransactionView, light_client_tip_height,
};
use crate::utils::bitcoin::{compute_tx_hash, ParsedTransaction};
use crate::utils::chadbuffer::read_transaction_from_buffer;
use crate::utils::{
    burn_zbtc_signed, close_account_securely, validate_account_writable, validate_program_owner,
    validate_token_2022_owner, validate_token_program_key,
};

/// Required BTC confirmations before completing redemption
const REQUIRED_CONFIRMATIONS: u64 = 6;

/// Maximum fee tolerance in satoshis (allows miner fee deduction)
const MAX_FEE_SATS: u64 = 50_000;

/// Complete redemption instruction data
///
/// Layout:
/// - btc_txid:      32 bytes - BTC transaction ID (internal byte order)
/// - tx_size:       4 bytes  - Raw tx size in ChadBuffer
pub struct CompleteRedemptionData {
    pub btc_txid: [u8; 32],
    pub tx_size: u32,
}

impl CompleteRedemptionData {
    pub const HEADER_SIZE: usize = 32 + 4; // 36 bytes

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::HEADER_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut btc_txid = [0u8; 32];
        btc_txid.copy_from_slice(&data[0..32]);

        let tx_size = u32::from_le_bytes(data[32..36].try_into().unwrap());

        Ok(Self {
            btc_txid,
            tx_size,
        })
    }
}

/// Process complete redemption with VerifiedTransaction PDA + output verification
///
/// # Accounts
/// 0.  `[writable]` Pool state
/// 1.  `[writable]` Redemption request
/// 2.  `[signer]`   Authority (pool authority)
/// 3.  `[]`         Rent recipient (receives lamports when PDA is closed)
/// 4.  `[]`         VerifiedTransaction PDA (owned by btc-relay)
/// 5.  `[]`         Light client (owned by btc-relay, for confirmation count)
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
    let verified_tx_info = &accounts[4];
    let light_client_info = &accounts[5];
    let tx_buffer_info = &accounts[6];
    let zbtc_mint = &accounts[7];
    let pool_vault = &accounts[8];
    let token_program = &accounts[9];

    // Parse instruction data (no merkle proof)
    let ix_data = CompleteRedemptionData::from_bytes(data)?;

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
    validate_program_owner(verified_tx_info, btc_lc_id)?;
    validate_program_owner(light_client_info, btc_lc_id)?;
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

    // Validate redemption state (must be Pending or Processing) and get details
    let (amount_sats, expected_script_len, expected_script) = {
        let redemption_data = redemption_info.try_borrow_data()?;
        let redemption = RedemptionRequest::from_bytes(&redemption_data)?;

        let status = redemption.get_status();
        if status != RedemptionStatus::Pending && status != RedemptionStatus::Processing {
            return Err(ZVaultError::InvalidRedemptionState.into());
        }

        let script = redemption.get_btc_script();
        let mut script_buf = [0u8; 62];
        let script_len = script.len();
        script_buf[..script_len].copy_from_slice(script);

        (redemption.amount_sats(), script_len, script_buf)
    };

    // --- VerifiedTransaction PDA check ---
    let block_height = {
        let vt_data = verified_tx_info.try_borrow_data()?;
        let vt = VerifiedTransactionView::from_bytes(&vt_data)?;

        // Verify txid matches
        if *vt.txid() != ix_data.btc_txid {
            return Err(ZVaultError::RedemptionSpvFailed.into());
        }

        vt.block_height() as u64
    };

    // Verify sufficient confirmations
    {
        let lc_data = light_client_info.try_borrow_data()?;
        let tip = light_client_tip_height(&lc_data)?;
        let confirmations = if block_height > tip {
            0
        } else {
            tip - block_height + 1
        };
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

    // --- Output verification ---
    // Parse raw tx and verify an output pays the expected script with sufficient amount
    let parsed_tx = ParsedTransaction::parse(raw_tx)
        .map_err(|_| ZVaultError::RedemptionSpvFailed)?;

    let expected_script_slice = &expected_script[..expected_script_len];
    let min_amount = amount_sats.saturating_sub(MAX_FEE_SATS);

    let mut found = false;
    for output in parsed_tx.outputs() {
        if output.script_pubkey == expected_script_slice && output.value >= min_amount {
            found = true;
            break;
        }
    }
    if !found {
        return Err(ZVaultError::RedemptionOutputMismatch.into());
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
