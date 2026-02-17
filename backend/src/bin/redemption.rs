//! Redemption Service Binary
//!
//! Processes zBTC burns and sends BTC withdrawals.
//!
//! Usage:
//!   redemption run [--interval <secs>]
//!   redemption withdraw <sol_tx> <user> <amount> <btc_addr>
//!   redemption status
//!   redemption requests
//!   redemption process <id>

use zbtc::redemption::{
    PoolUtxo, RedemptionConfig, RedemptionService, SingleKeySigner, TxSigner,
};
use zbtc::units;
use std::env;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        return;
    }

    match args[1].as_str() {
        "run" => cmd_run(&args[2..]).await,
        "withdraw" => cmd_withdraw(&args[2..]).await,
        "status" => cmd_status().await,
        "requests" => cmd_requests().await,
        "process" => cmd_process(&args[2..]).await,
        "add-utxo" => cmd_add_utxo(&args[2..]).await,
        "keygen" => cmd_keygen(),
        "help" | "--help" | "-h" => print_usage(),
        _ => print_usage(),
    }
}

fn print_usage() {
    println!("zVault Redemption Service - BTC Withdrawal Processor");
    println!();
    println!("Usage:");
    println!("  redemption run [--interval <secs>]              Run service loop");
    println!("  redemption withdraw <sol_tx> <user> <amt> <addr> Submit withdrawal");
    println!("  redemption status                                Show service status");
    println!("  redemption requests                              List withdrawal requests");
    println!("  redemption process <id>                          Process specific request");
    println!("  redemption add-utxo <txid> <vout> <amount> <script>");
    println!("  redemption keygen                                Generate new signing key");
    println!();
    println!("Examples:");
    println!("  redemption run --interval 30");
    println!("  redemption withdraw sol_tx123 user_pub 100000 tb1q...");
    println!("  redemption keygen");
    println!();
    println!("Environment:");
    println!("  POOL_SIGNING_KEY   Hex-encoded 32-byte signing key");
    println!("  SOLANA_RPC_URL     Solana RPC endpoint");
    println!("  ESPLORA_URL        Esplora API URL");
}

fn get_service() -> RedemptionService {
    // Check for signing key in environment
    if let Ok(key_hex) = env::var("POOL_SIGNING_KEY") {
        match SingleKeySigner::from_hex(&key_hex) {
            Ok(signer) => {
                return RedemptionService::new_with_signer(RedemptionConfig::default(), signer);
            }
            Err(e) => {
                eprintln!("Warning: Invalid POOL_SIGNING_KEY: {}", e);
            }
        }
    }

    // Use generated key
    RedemptionService::new_testnet()
}

async fn cmd_run(args: &[String]) {
    let mut config = RedemptionConfig::default();

    // Parse arguments
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--interval" if i + 1 < args.len() => {
                config.check_interval_secs = args[i + 1].parse().unwrap_or(30);
                i += 2;
            }
            "--min-amount" if i + 1 < args.len() => {
                config.min_withdrawal = args[i + 1].parse().unwrap_or(10_000);
                i += 2;
            }
            _ => i += 1,
        }
    }

    let service = get_service();

    println!("=== zVault Redemption Service ===");
    println!();
    println!("Configuration:");
    println!("  Check Interval: {} seconds", config.check_interval_secs);
    println!("  Min Withdrawal: {}", units::format_sats(config.min_withdrawal));
    println!("  Max Withdrawal: {}", units::format_sats(config.max_withdrawal));
    println!();
    println!("Signer: {} ({})", service.signer_type(), service.pool_public_key());
    println!();
    println!("Press Ctrl+C to stop");
    println!();

    if let Err(e) = service.run().await {
        eprintln!("Error: {}", e);
    }
}

async fn cmd_withdraw(args: &[String]) {
    if args.len() < 4 {
        println!("Usage: redemption withdraw <sol_tx> <user> <amount_sats> <btc_address>");
        return;
    }

    let sol_tx = &args[0];
    let user = &args[1];
    let amount: u64 = match args[2].parse() {
        Ok(a) => a,
        Err(_) => {
            println!("Error: Invalid amount");
            return;
        }
    };
    let btc_address = &args[3];

    let service = get_service();

    match service
        .submit_withdrawal(sol_tx.clone(), user.clone(), amount, btc_address.clone())
        .await
    {
        Ok(id) => {
            println!("Withdrawal request submitted!");
            println!("  ID: {}", id);
            println!("  Amount: {}", units::format_sats(amount));
            println!("  Destination: {}", btc_address);
            println!();
            println!("Use 'redemption process {}' to process it.", id);
        }
        Err(e) => {
            println!("Error: {}", e);
        }
    }
}

async fn cmd_status() {
    let service = get_service();

    println!("=== Redemption Service Status ===");
    println!();
    println!("Network: Bitcoin Testnet / Solana Devnet");
    println!("Signer: {} ({})", service.signer_type(), service.pool_public_key());
    println!();

    let stats = service.stats().await;
    println!("Statistics:");
    println!("  Total Requests: {}", stats.total_requests);
    println!("  Pending: {}", stats.pending);
    println!("  Processing: {}", stats.processing);
    println!("  Complete: {}", stats.complete);
    println!("  Failed: {}", stats.failed);
    println!();
    println!("  Total Withdrawn: {}", units::format_sats(stats.total_sats_withdrawn));
    println!("  Total Fees: {}", units::format_sats(stats.total_fees_paid));
}

async fn cmd_requests() {
    let service = get_service();
    let requests = service.get_all_requests().await;

    if requests.is_empty() {
        println!("No withdrawal requests.");
        println!();
        println!("Use 'redemption withdraw ...' to submit a request.");
        return;
    }

    println!("=== Withdrawal Requests ({}) ===", requests.len());
    println!();

    for req in requests {
        println!("---");
        println!("ID: {}", req.id);
        println!("Amount: {}", units::format_sats(req.amount_sats));
        println!("Fee: {}", units::format_sats(req.fee_sats));
        println!("Net: {}", units::format_sats(req.net_amount()));
        println!("Destination: {}", req.btc_address);
        println!("Status: {}", req.status);
        if let Some(ref txid) = req.btc_txid {
            println!("BTC TXID: {}", txid);
            println!("Confirmations: {}", req.btc_confirmations);
        }
        if let Some(ref err) = req.error {
            println!("Error: {}", err);
        }
        println!();
    }
}

async fn cmd_process(args: &[String]) {
    if args.is_empty() {
        println!("Usage: redemption process <request_id>");
        return;
    }

    let id = &args[0];
    let service = get_service();

    // Check if request exists
    match service.get_request(id).await {
        Some(req) => {
            println!("Processing request: {}", id);
            println!("Amount: {}", units::format_sats(req.amount_sats));
            println!();
        }
        None => {
            println!("Error: Request not found: {}", id);
            return;
        }
    }

    match service.process_withdrawal(id).await {
        Ok(result) => {
            println!("Withdrawal processed!");
            println!("  Request ID: {}", result.request_id);
            println!("  BTC TXID: {}", result.btc_txid);
            println!("  Fee: {}", units::format_sats(result.fee));
            println!();
            println!("Transaction broadcasted (simulated). Waiting for confirmations...");
        }
        Err(e) => {
            println!("Error: {}", e);
        }
    }
}

async fn cmd_add_utxo(args: &[String]) {
    if args.len() < 4 {
        println!("Usage: redemption add-utxo <txid> <vout> <amount_sats> <script_pubkey_hex>");
        return;
    }

    let txid = &args[0];
    let vout: u32 = match args[1].parse() {
        Ok(v) => v,
        Err(_) => {
            println!("Error: Invalid vout");
            return;
        }
    };
    let amount: u64 = match args[2].parse() {
        Ok(a) => a,
        Err(_) => {
            println!("Error: Invalid amount");
            return;
        }
    };
    let script = &args[3];

    let utxo = PoolUtxo {
        txid: txid.clone(),
        vout,
        amount_sats: amount,
        script_pubkey: script.clone(),
    };

    let service = get_service();
    service.add_pool_utxo(utxo).await;

    println!("Pool UTXO added:");
    println!("  Outpoint: {}:{}", txid, vout);
    println!("  Amount: {}", units::format_sats(amount));
}

fn cmd_keygen() {
    let signer = SingleKeySigner::generate();

    println!("=== New Signing Key Generated ===");
    println!();
    println!("Public Key: {}", signer.public_key());
    println!("Secret Key: {}", signer.secret_hex());
    println!();
    println!("IMPORTANT: Save the secret key securely!");
    println!();
    println!("To use this key, set:");
    println!("  export POOL_SIGNING_KEY={}", signer.secret_hex());
}
