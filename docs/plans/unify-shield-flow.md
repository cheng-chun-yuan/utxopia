# Plan: Unify BTC + SPL Shield Flow UI

## Goal
Make the BTC deposit flow look identical to the SPL shield flow (zkBTC/SOL/USDC view).
Currently they're two completely different UIs that confuse users.

## Current State

**SPL flow** (right screenshot — the good one):
- Wallet connection bar (SOL address + disconnect)
- Amount input with MAX button + token selector dropdown
- Recipient field (aegis: address)
- "Shield zkBTC" button

**BTC flow** (left screenshot — the ugly one):
- Separate `<DepositFlow />` component embedded in a bordered box
- Different layout: Demo Mode toggle at top, Recipient, Amount (satoshis), Preview button
- No wallet connection bar (uses bitcoin-wallet-store separately)
- Completely different visual style

## Target State

BTC flow should use the SAME layout as SPL:
```
┌─────────────────────────────────────────┐
│ 🔶 tb1p...xyz  📋           Disconnect │  ← BTC wallet (sats-connect/Unisat)
├─────────────────────────────────────────┤
│ Amount                    Balance: X BTC│
│ ┌─────────────────── ┌────┐ ┌────────┐ │
│ │ 0.00               │MAX │ │ 🔶 BTC▾│ │  ← Amount in BTC (not sats)
│ └─────────────────── └────┘ └────────┘ │
│                                         │
│ Recipient                               │
│ ┌─────────────────────────────────────┐ │
│ │ alice.btcpro.sol or aegis:...       │ │
│ └─────────────────────────────────────┘ │
│ ✓ Valid stealth address                 │
│                                         │
│ ⚡ Demo Mode                      [  ] │  ← Toggle (localnet/devnet only)
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │        ◯ Shield BTC                 │ │  ← Same button style as SPL
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## Implementation

### Files to modify
1. `aegis-app/src/components/shield-flow.tsx` — the BTC branch (lines 392-410)
2. `aegis-app/src/components/btc-widget/deposit-flow.tsx` — extract demo logic, may simplify

### Approach: Inline BTC into shield-flow.tsx

Instead of rendering `<DepositFlow />` as a child component, inline the BTC deposit logic
directly into the shield-flow's BTC branch, using the same layout components:

1. **Wallet bar**: Replace SOL wallet bar with BTC wallet bar
   - Use `useBitcoinWalletStore` for connection state
   - Show `tb1p...` address with copy + disconnect
   - "Connect BTC Wallet" button if not connected

2. **Amount input**: Same `<input>` + MAX + token selector as SPL
   - Display in BTC (not sats) — convert internally
   - MAX reads BTC wallet UTXOs balance
   - Token selector locked to BTC (dropdown still works to switch to other tokens)

3. **Recipient**: Already exists in DepositFlow, reuse `<StealthRecipientInput />`

4. **Demo Mode toggle**: Show only on localnet/devnet
   - When demo=true: call backend demo deposit API (disc=13) — no real BTC needed
   - When demo=false: generate Taproot address, build PSBT, sign with BTC wallet

5. **Shield button**: Same green gradient button as SPL flow
   - Demo mode: "Shield BTC (Demo)"
   - Real mode: "Preview Transaction" → generates PSBT

### What to keep from DepositFlow
- Demo deposit logic (API call to backend)
- PSBT building for real deposits
- Deposit tracking (confirmation status)

### What to remove
- The bordered box wrapper (`rounded-[12px] border border-btc/15 bg-btc/5 p-4`)
- Separate layout/styling

### Risk: Low
- CSS/layout changes only for the wrapper
- Business logic stays the same (demo API, PSBT building)
- Can revert if anything breaks

## NOT in scope
- Changing how real BTC deposits work (Taproot, SPV, etc.)
- Modifying the deposit tracking/confirmation UI (post-deposit)
- Changing the backend demo deposit API
