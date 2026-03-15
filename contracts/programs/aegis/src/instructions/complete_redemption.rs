//! Complete redemption instruction — verify BTC delivery via VerifiedTransaction PDA, burn zkBTC, close PDA
//!
//! ESCROW-BASED ARCHITECTURE:
//! - Authority provides btc_txid matching a VerifiedTransaction PDA (btc-light-client verified SPV)
//! - On-chain: parse raw tx from ChadBuffer, verify output pays correct address/amount
//! - On success: burn zkBTC from pool vault, close RedemptionRequest PDA
//! - NullifierRecord is NOT closed — it must persist forever to prevent double-spend

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::{
    PoolState, RedemptionRequest, RedemptionStatus,
    VerifiedTransactionView, light_client_tip_height,
    completion_receipt::{CompletionReceipt, COMPLETION_RECEIPT_DISCRIMINATOR},
};
use crate::utils::bitcoin::{compute_tx_hash, ParsedTransaction};
use crate::utils::chadbuffer::read_transaction_from_buffer;
use crate::utils::{
    burn_zkbtc_signed, close_account_securely, create_pda_account,
    validate_account_writable, validate_program_owner,
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
/// 4.  `[]`         VerifiedTransaction PDA (owned by btc-light-client)
/// 5.  `[]`         Light client (owned by btc-light-client, for confirmation count)
/// 6.  `[]`         Transaction buffer (ChadBuffer)
/// 7.  `[writable]` zkBTC mint
/// 8.  `[writable]` Pool vault
/// 9.  `[]`         Token-2022 program
/// 10. `[writable]` Completion receipt PDA (prevents same BTC txid being used twice)
/// 11. `[]`         System program
pub fn process_complete_redemption(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 12 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let redemption_info = &accounts[1];
    let authority = &accounts[2];
    let rent_recipient = &accounts[3];
    let verified_tx_info = &accounts[4];
    let light_client_info = &accounts[5];
    let tx_buffer_info = &accounts[6];
    let zkbtc_mint = &accounts[7];
    let pool_vault = &accounts[8];
    let token_program = &accounts[9];
    let completion_receipt_info = &accounts[10];
    let _system_program = &accounts[11];

    // Parse instruction data (no merkle proof)
    let ix_data = CompleteRedemptionData::from_bytes(data)?;

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate account owners
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(redemption_info, program_id)?;
    validate_account_writable(completion_receipt_info)?;
    let btc_lc_id: &Pubkey = unsafe {
        &*(&crate::constants::BTC_LIGHT_CLIENT_PROGRAM_ID as *const [u8; 32] as *const Pubkey)
    };
    validate_program_owner(verified_tx_info, btc_lc_id)?;
    validate_program_owner(light_client_info, btc_lc_id)?;
    validate_token_2022_owner(zkbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;

    // Validate writable accounts
    validate_account_writable(pool_state_info)?;
    validate_account_writable(redemption_info)?;
    validate_account_writable(zkbtc_mint)?;
    validate_account_writable(pool_vault)?;

    // Validate authority and get pool state
    let (pool_bump, pending_redemptions) = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }

        (pool.bump, pool.pending_redemptions())
    };

    // --- Completion receipt: prevent same BTC txid from completing two redemptions ---
    {
        let receipt_seeds: &[&[u8]] = &[CompletionReceipt::SEED, &ix_data.btc_txid];
        let (expected_receipt_pda, receipt_bump) = find_program_address(receipt_seeds, program_id);
        if completion_receipt_info.key() != &expected_receipt_pda {
            return Err(ProgramError::InvalidSeeds);
        }

        // Check if this BTC txid was already used for a completion
        {
            let receipt_data = completion_receipt_info.try_borrow_data()?;
            if !receipt_data.is_empty() && receipt_data[0] == COMPLETION_RECEIPT_DISCRIMINATOR {
                pinocchio::msg!("Aegis: BTC txid already used for completion");
                return Err(AegisError::DuplicateDeposit.into());
            }
        }

        // Create completion receipt PDA
        let rent = Rent::get()?;
        let bump_bytes = [receipt_bump];
        let signer_seeds: &[&[u8]] = &[
            CompletionReceipt::SEED,
            &ix_data.btc_txid,
            &bump_bytes,
        ];

        create_pda_account(
            authority,
            completion_receipt_info,
            program_id,
            rent.minimum_balance(CompletionReceipt::LEN),
            CompletionReceipt::LEN as u64,
            signer_seeds,
        )?;

        let mut receipt_data = completion_receipt_info.try_borrow_mut_data()?;
        CompletionReceipt::init(&mut receipt_data)?;
    }

    // Validate redemption state (must be Pending or Processing) and get details
    let (amount_sats, service_fee, expected_script_len, expected_script, requester_key, request_id) = {
        let redemption_data = redemption_info.try_borrow_data()?;
        let redemption = RedemptionRequest::from_bytes(&redemption_data)?;

        let status = redemption.get_status();
        if status != RedemptionStatus::Pending && status != RedemptionStatus::Processing {
            return Err(AegisError::InvalidRedemptionState.into());
        }

        let script = redemption.get_btc_script();
        let mut script_buf = [0u8; 62];
        let script_len = script.len();
        script_buf[..script_len].copy_from_slice(script);

        let mut req_key = [0u8; 32];
        req_key.copy_from_slice(&redemption.requester);

        (redemption.amount_sats(), redemption.service_fee(), script_len, script_buf, req_key, redemption.request_id())
    };

    // --- VerifiedTransaction PDA check ---
    let block_height = {
        let vt_data = verified_tx_info.try_borrow_data()?;
        let vt = VerifiedTransactionView::from_bytes(&vt_data)?;

        // Verify txid matches
        if *vt.txid() != ix_data.btc_txid {
            return Err(AegisError::RedemptionSpvFailed.into());
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
            return Err(AegisError::InsufficientConfirmations.into());
        }
    }

    // Read raw transaction from ChadBuffer
    crate::utils::chadbuffer::validate_chadbuffer_owner(tx_buffer_info)?;
    let buffer_data = tx_buffer_info
        .try_borrow_data()
        .map_err(|_| AegisError::RedemptionSpvFailed)?;
    let raw_tx = read_transaction_from_buffer(&buffer_data, ix_data.tx_size as usize)?;

    // Verify transaction hash matches provided txid
    let computed_hash = compute_tx_hash(raw_tx);
    if computed_hash != ix_data.btc_txid {
        return Err(AegisError::RedemptionSpvFailed.into());
    }

    // --- Output verification ---
    // Parse raw tx and verify an output pays the expected script with sufficient amount
    let parsed_tx = ParsedTransaction::parse(raw_tx)
        .map_err(|_| AegisError::RedemptionSpvFailed)?;

    let expected_script_slice = &expected_script[..expected_script_len];

    // Service fee was locked at request time in the PDA — no re-computation needed.
    // This ensures the user gets the fee they agreed to, even if pool config changes.

    // expected_send = amount_sats - service_fee (what we intended to send to user)
    let expected_send = amount_sats.saturating_sub(service_fee);
    let min_amount = expected_send.saturating_sub(MAX_FEE_SATS);

    // Find the matching output and capture the actual value sent
    let mut actual_received: u64 = 0;
    let mut found = false;
    for output in parsed_tx.outputs() {
        if output.script_pubkey == expected_script_slice && output.value >= min_amount {
            actual_received = output.value;
            found = true;
            break;
        }
    }
    if !found {
        return Err(AegisError::RedemptionOutputMismatch.into());
    }

    // --- Compute burn amount ---
    // Only burn what actually left the pool as BTC (user receives + miner fee).
    // Service fee stays in the vault as protocol revenue (not burned).
    //
    // Accounting:
    //   expected_send = amount_sats - service_fee (intended BTC to user)
    //   miner_fee = expected_send - actual_received (deducted by BTC network)
    //   protocol_revenue = service_fee - miner_fee (pool keeps this in vault)
    //   burn_amount = actual_received + miner_fee = expected_send = amount_sats - protocol_revenue
    let miner_fee = expected_send.saturating_sub(actual_received);
    let protocol_revenue = service_fee.saturating_sub(miner_fee);
    let burn_amount = amount_sats.saturating_sub(protocol_revenue);

    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    burn_zkbtc_signed(
        token_program,
        zkbtc_mint,
        pool_vault,
        pool_state_info,
        burn_amount,
        pool_signer_seeds,
    )?;

    // --- Update pool state with exact accounting ---
    let clock = Clock::get()?;
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        // total_burned tracks what was actually burned (= BTC that left the pool)
        pool.add_burned(burn_amount)?;

        // Protocol revenue stays in vault as unburned tokens
        if protocol_revenue > 0 {
            pool.add_fee_pool(protocol_revenue)?;
        }

        pool.set_pending_redemptions(pending_redemptions.saturating_sub(1));
        pool.set_last_update(clock.unix_timestamp);
    }

    // --- Emit completion event (before PDA is closed) ---
    crate::utils::events::emit_redemption_completed(
        &requester_key,
        amount_sats,
        actual_received,
        service_fee,
        request_id,
        &ix_data.btc_txid,
        &expected_script[..expected_script_len],
    );

    // --- Close RedemptionRequest PDA ---
    close_account_securely(redemption_info, rent_recipient)?;

    pinocchio::msg!("Aegis: redemption completed");
    Ok(())
}
