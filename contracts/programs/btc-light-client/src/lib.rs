//! BTC Light Client Program
//!
//! Manages Bitcoin light client state and block headers for SPV verification.
//! Uses the same account layouts as zvault so it can read these accounts directly.

mod constants;
mod state;
mod utils;
mod instructions;

use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use instructions::{
    process_initialize,
    process_submit_header,
    process_reset_tip,
    process_verify_transaction,
    process_reorg_header,
    process_close_block_header,
    process_reinitialize,
};

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match data[0] {
        0 => process_initialize(program_id, accounts, &data[1..]),
        1 => process_submit_header(program_id, accounts, &data[1..]),
        2 => process_reset_tip(program_id, accounts, &data[1..]),
        3 => process_verify_transaction(program_id, accounts, &data[1..]),
        4 => process_reorg_header(program_id, accounts, &data[1..]),
        5 => process_close_block_header(program_id, accounts, &data[1..]),
        6 => process_reinitialize(program_id, accounts, &data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
