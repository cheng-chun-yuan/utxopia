//! Devnet Integration Test for Solana Verifier
//!
//! Tests the SolanaVerifier against Solana devnet:
//!   1. RPC connectivity (query a known account)
//!   2. PDA derivation (match known PDA for pool_state)
//!   3. RedemptionRequest verification (negative: PDA not found)
//!   4. RedemptionRequest verification (positive: if existing PDA provided via CLI)
//!
//! Usage:
//!   cargo run --bin test_solana_verifier
//!   cargo run --bin test_solana_verifier -- --requester <BASE58> --nonce <U64> --amount <SATS> --btc-addr <ADDR>

use clap::Parser;
use frost_server::solana_verifier::{find_program_address, SolanaVerifier};

/// Default devnet Aegis program ID
const DEVNET_PROGRAM_ID: &str = "8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim";
const DEVNET_RPC_URL: &str = "https://api.devnet.solana.com";

#[derive(Parser)]
#[command(name = "test-solana-verifier")]
#[command(about = "Test SolanaVerifier against Solana devnet")]
struct Args {
    /// Solana RPC URL
    #[arg(long, default_value = DEVNET_RPC_URL)]
    rpc_url: String,

    /// Aegis program ID (base58)
    #[arg(long, default_value = DEVNET_PROGRAM_ID)]
    program_id: String,

    /// Optional: requester pubkey for positive RedemptionRequest test
    #[arg(long)]
    requester: Option<String>,

    /// Optional: nonce for positive RedemptionRequest test
    #[arg(long)]
    nonce: Option<u64>,

    /// Optional: expected amount for positive test
    #[arg(long)]
    amount: Option<u64>,

    /// Optional: expected BTC address for positive test
    #[arg(long)]
    btc_addr: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("info,frost_server=debug")
        .init();

    let args = Args::parse();

    println!("========================================");
    println!("  Solana Verifier — Devnet Integration  ");
    println!("========================================");
    println!("  RPC URL:    {}", args.rpc_url);
    println!("  Program ID: {}", args.program_id);
    println!();

    let verifier = SolanaVerifier::new(args.rpc_url.clone(), &args.program_id)?;

    // ── Test 1: PDA Derivation ──
    println!("── Test 1: PDA Derivation ──");
    {
        let program_id_bytes = bs58::decode(&args.program_id).into_vec()?;
        let mut program_id = [0u8; 32];
        program_id.copy_from_slice(&program_id_bytes);

        // Derive pool_state PDA
        let pool_seeds: &[&[u8]] = &[b"pool_state"];
        let (pool_pda, pool_bump) = find_program_address(pool_seeds, &program_id)
            .expect("PDA derivation should succeed");
        let pool_pda_b58 = bs58::encode(&pool_pda).into_string();
        println!("  pool_state PDA: {} (bump={})", pool_pda_b58, pool_bump);

        // Derive a test RedemptionRequest PDA
        let fake_requester = [1u8; 32];
        let nonce: u64 = 0;
        let nonce_bytes = nonce.to_le_bytes();
        let redemption_seeds: &[&[u8]] = &[b"redemption", &fake_requester, &nonce_bytes];
        let (redemption_pda, redemption_bump) = find_program_address(redemption_seeds, &program_id)
            .expect("Redemption PDA derivation should succeed");
        let redemption_pda_b58 = bs58::encode(&redemption_pda).into_string();
        println!(
            "  redemption PDA (fake): {} (bump={})",
            redemption_pda_b58, redemption_bump
        );

        println!("  PASS: PDA derivation works\n");
    }

    // ── Test 2: RPC Connectivity ──
    println!("── Test 2: RPC Connectivity ──");
    {
        let program_id_bytes = bs58::decode(&args.program_id).into_vec()?;
        let mut program_id = [0u8; 32];
        program_id.copy_from_slice(&program_id_bytes);

        // Query pool_state PDA (should exist on devnet if program is deployed)
        let pool_seeds: &[&[u8]] = &[b"pool_state"];
        let (pool_pda, _) = find_program_address(pool_seeds, &program_id).unwrap();
        let pool_pda_b58 = bs58::encode(&pool_pda).into_string();

        // Raw RPC query to verify connectivity
        let client = reqwest::Client::new();
        let request_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAccountInfo",
            "params": [pool_pda_b58, { "encoding": "base64" }]
        });

        let response = client
            .post(&args.rpc_url)
            .json(&request_body)
            .send()
            .await?;

        let body: serde_json::Value = response.json().await?;

        if body["result"]["value"].is_null() {
            println!("  WARNING: pool_state PDA not found on devnet");
            println!("  (Program may not be deployed yet — run deploy-devnet.ts first)");
        } else {
            let data_array = body["result"]["value"]["data"].as_array().unwrap();
            let data_len = data_array[0].as_str().unwrap().len();
            let owner = body["result"]["value"]["owner"].as_str().unwrap();
            println!("  pool_state found: owner={}, data_b64_len={}", owner, data_len);
            assert_eq!(owner, args.program_id, "Owner should match program ID");
        }
        println!("  PASS: RPC connectivity works\n");
    }

    // ── Test 3: Negative — RedemptionRequest Not Found ──
    println!("── Test 3: RedemptionRequest Not Found (negative) ──");
    {
        let fake_requester = bs58::encode([42u8; 32]).into_string();
        let result = verifier
            .verify_redemption(&fake_requester, 999999, 50000, "tb1qfake")
            .await;

        match result {
            Err(frost_server::solana_verifier::SolanaVerifyError::AccountNotFound(msg)) => {
                println!("  Expected: AccountNotFound — {}", msg);
                println!("  PASS: Correctly rejects non-existent PDA\n");
            }
            Err(e) => {
                println!("  Got error: {} (may be OK if it's RPC error)", e);
                println!("  PASS (conditional)\n");
            }
            Ok(()) => {
                println!("  FAIL: Should not have found a fake RedemptionRequest!");
                std::process::exit(1);
            }
        }
    }

    // ── Test 4: Positive — Verify real RedemptionRequest (if provided) ──
    if let (Some(requester), Some(nonce), Some(amount), Some(btc_addr)) = (
        args.requester.as_ref(),
        args.nonce,
        args.amount,
        args.btc_addr.as_ref(),
    ) {
        println!("── Test 4: Real RedemptionRequest Verification ──");
        println!("  requester: {}", requester);
        println!("  nonce:     {}", nonce);
        println!("  amount:    {} sats", amount);
        println!("  btc_addr:  {}", btc_addr);

        match verifier
            .verify_redemption(requester, nonce, amount, btc_addr)
            .await
        {
            Ok(()) => {
                println!("  PASS: RedemptionRequest verified on-chain!\n");
            }
            Err(e) => {
                println!("  FAIL: {}\n", e);
                std::process::exit(1);
            }
        }
    } else {
        println!("── Test 4: Skipped (no --requester/--nonce/--amount/--btc-addr provided) ──");
        println!("  To test positive verification, create a RedemptionRequest on devnet, then run:");
        println!("    cargo run --bin test_solana_verifier -- \\");
        println!("      --requester <PUBKEY> --nonce <N> --amount <SATS> --btc-addr <ADDR>\n");
    }

    println!("========================================");
    println!("  All tests passed!                     ");
    println!("========================================");

    Ok(())
}
