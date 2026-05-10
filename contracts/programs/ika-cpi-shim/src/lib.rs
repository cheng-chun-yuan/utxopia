//! Test-only Pinocchio program that wraps `privacy_coin::cpi::ika::approve_message`.
//!
//! This crate exists solely to give the LiteSVM integration test
//! (`privacy-coin/tests/complete_redemption_ika_cpi.rs`) a *real*
//! Pinocchio program from which to issue the CPI. The Ika dWallet program
//! validates that its caller is an executable Solana program whose CPI
//! authority PDA matches the dWallet's stored authority — so we cannot
//! call `approve_message` directly from a test transaction.
//!
//! The instruction layout intentionally mirrors what `complete_redemption`
//! passes through to `approve_message`, so a green test here is direct
//! evidence that the byte layout, PDA seeds, and `invoke_signed` signer
//! seeds in `privacy_coin::cpi::ika` are correct against the real upstream
//! Ika `.so`.
//!
//! Instruction data layout:
//!   [0..32]   message_digest    (the BTC sighash to approve)
//!   [32..64]  metadata_digest   (zeroed for Taproot)
//!   [64..96]  user_pubkey       (we echo the sighash here, like prod)
//!   [96]      cpi_authority_bump
//!   [97]      message_approval_bump
//!
//! Account layout (matches the 7 Ika-tail accounts plus the system program
//! that `complete_redemption` passes after its 13 base accounts):
//!   [0] ika_program        (executable; the Ika dWallet program)
//!   [1] ika_coordinator    (readonly; owned by the Ika program)
//!   [2] message_approval   (writable; will be created by the CPI)
//!   [3] ika_dwallet        (readonly; authority must equal cpi_authority)
//!   [4] caller_program     (this shim's own program account; readonly, executable)
//!   [5] cpi_authority      (PDA at ["__ika_cpi_authority"])
//!   [6] payer              (writable, signer)
//!   [7] system_program     (readonly)

use pinocchio::{
    account_info::AccountInfo, entrypoint, program_error::ProgramError, pubkey::Pubkey,
    ProgramResult,
};

use privacy_coin::cpi::ika::{approve_message, ApproveMessageAccounts, SIG_SCHEME_TAPROOT_SHA256};

entrypoint!(process_instruction);

/// Length of the instruction-data payload this program expects.
pub const SHIM_IX_DATA_LEN: usize = 32 + 32 + 32 + 1 + 1;

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < SHIM_IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let mut message_digest = [0u8; 32];
    message_digest.copy_from_slice(&data[0..32]);
    let mut metadata_digest = [0u8; 32];
    metadata_digest.copy_from_slice(&data[32..64]);
    let mut user_pubkey = [0u8; 32];
    user_pubkey.copy_from_slice(&data[64..96]);
    let cpi_authority_bump = data[96];
    let message_approval_bump = data[97];

    let ika_program = &accounts[0];
    let ika_coordinator = &accounts[1];
    let message_approval = &accounts[2];
    let ika_dwallet = &accounts[3];
    let caller_program = &accounts[4];
    let cpi_authority = &accounts[5];
    let payer = &accounts[6];
    let system_program = &accounts[7];

    approve_message(
        ApproveMessageAccounts {
            coordinator: ika_coordinator,
            message_approval,
            dwallet: ika_dwallet,
            caller_program,
            cpi_authority,
            payer,
            system_program,
            dwallet_program: ika_program,
        },
        &message_digest,
        &metadata_digest,
        &user_pubkey,
        SIG_SCHEME_TAPROOT_SHA256,
        message_approval_bump,
        cpi_authority_bump,
    )
}
