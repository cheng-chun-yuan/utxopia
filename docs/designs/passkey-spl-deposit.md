# Passkey SPL Deposit — Design Doc

## Problem
Passkey users can deposit BTC (send to Taproot address, backend sweeps) but cannot deposit SOL/USDC/USDT because the shield instruction requires a Solana wallet signature.

## Solution (Railgun Model)
Follow the same model as Railgun (the #1 EVM privacy protocol): **users connect a Solana wallet to shield SPL tokens, then use passkey-derived ZK keys for all private operations.**

This is the industry standard — Railgun requires a wallet for shielding, then all transfers/swaps/unshields are ZK-proof based via relayers with no wallet needed.

## Flow

```
PASSKEY USER SHIELDING SPL TOKENS:
═══════════════════════════════════
1. User logs in with passkey → derives ZK keys (spending/nullifying/viewing)
2. User selects SOL/USDC/USDT in shield flow
3. UI shows: "Connect Wallet to Shield [TOKEN]"
   → "Shielding requires a Solana wallet to sign the deposit transaction.
      After shielding, all private operations use your passkey."
4. User connects Phantom/Solflare/etc.
5. User enters amount, signs the shield transaction (wallet signs)
6. ZK commitment computed using passkey-derived keys (NPK, ephemeral)
7. Tokens are shielded ✓

AFTER SHIELDING (no wallet needed):
════════════════════════════════════
- Private transfer → ZK proof + relayer (passkey signs)
- Unshield → ZK proof + relayer (passkey signs)
- BTC redeem → ZK proof + FROST (passkey signs)
```

## Why Not a Deposit PDA?
We explored per-user PDA deposit addresses (backend detects transfer → auto-shields).
The paradox: if a user has tokens in a Solana wallet to send to the PDA, they already have a wallet that can sign the shield tx directly. The PDA is only useful for exchange withdrawals — a niche case for a hackathon.

## Implementation
Single file change: `privacy-coin-app/src/components/shield-flow.tsx`
- Show all tokens to passkey users (not just BTC)
- When passkey user selects SPL token without wallet: show "Connect Wallet" prompt
- After wallet connected: existing shield flow works as-is

## Phase 2 (deferred)
- PDA deposit address for exchange/third-party deposits
- On-chain DepositIntent PDA for trustless deposit registration
- `shield_from_deposit_pda` instruction
- `reclaim_deposit` instruction with timeout for fund recovery
