# UTXOpia — 60-Second Demo Script

A literal stage-by-stage script for the hackathon demo recording. Total runtime: 60 seconds. The arc is: **what it does → how the privacy works → the Ika moment → the on-chain proof of custody**.

The Ika integration is the headline, so it has to be on screen by 0:35. The first 30 seconds set up *why* anyone should care; the last 25 seconds prove the claim.

---

## Pre-flight checklist (set up before recording)

Have these ready in separate tabs/windows so you never fumble:

1. **Browser window 1 — the app.** `http://localhost:3000/send` open, devnet wallet already connected and funded. Have a stealth address pre-copied to the clipboard (or a `.btcpro.sol` name resolvable on devnet, e.g. `demo.btcpro.sol`).
2. **Browser window 2 — Solana Explorer (devnet).** Pre-load the program redeploy tx so the second tab is already showing the UTXOpia program's recent CPI activity: `https://explorer.solana.com/tx/5jWR2UEf6LtAfWHD9wibtA7yPptAWYmZCLW3pKxGhNetmn7UB287ExnN6CpNpTGcCfNuQT4nQ2vUGWMvzajiMQ1T?cluster=devnet`
3. **Browser window 3 — Solana Explorer, Ika dWallet account.** `https://explorer.solana.com/address/DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq?cluster=devnet`. This is the proof-of-custody screen. Pin it to a clearly visible tab.
4. **Terminal pane (optional, for the close).** Have a `cat` of the four canonical addresses staged, in case the Explorer is slow:
   - UTXOpia program: `G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy`
   - Ika dWallet PDA: `DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq`
   - CPI authority PDA: `CvHHu36G9srBErXVLFzXR5yRuCS3JcZy2dtZ3a91cviv`
   - Pool BTC address (testnet4): `tb1p99y96qcldtg6krzv5uvrhmmvh88zmy2dp0kgmjzz56tz7r7vxd3qqn2q95`
5. **OBS/Loom set to record the full screen** (not just one window) so judges can see the tab switches.
6. **Notifications off, dark-mode consistent across windows.**

Backstop: if the Ika `Sign` PDA + Bitcoin broadcast isn't live by demo time, the BTC-withdraw segment **must not pretend**. The fallback is to show the on-chain CPI trace from our program into the Ika program on Explorer — that is the proof of custody.

---

## The script

| Time | Screen action | Voiceover |
|---|---|---|
| **0:00 – 0:08** | Window 1: `/send` route. The page is already open. Paste a `.btcpro.sol` name (e.g. `demo.btcpro.sol`) into the recipient field. The stealth meta-address auto-resolves and the UI flips into "Send privately" mode. | "UTXOpia makes Bitcoin private on Solana. This is the unified send screen — deposit, transfer, unshield, or redeem all start the same way: just a recipient and an amount." |
| **0:08 – 0:20** | Stay in window 1. Hover the resolved stealth address. Show the auto-detected stealth-address card with the ECDH-derived one-time address. Pick an amount (say 0.0025 BTC). The fee preview shows the JoinSplit dimensions (e.g. `1×2`). | "Recipients are stealth addresses — every send goes to a fresh one-time address, unlinkable on-chain. We use Baby Jubjub spending keys plus Ed25519 viewing keys, EIP-5564 style. There's no public zkBTC token. The amount lives inside a commitment hash." |
| **0:20 – 0:35** | Click **Continue**. The review modal slides in: recipient stealth address, amount, fee. Hold the **Hold-to-Send** button until it fills. The UI shows "Proving…" with a small progress indicator (snarkjs WASM running client-side), then "Submitting…". A devnet tx signature appears. | "Every transfer is a Groth16 JoinSplit proof generated in the browser — N inputs to M outputs, ~256-byte proof, ~95k compute units to verify. The Solana program checks the proof, marks nullifiers, inserts new commitments. No middleman saw the amount." |
| **0:35 – 0:50** | Cut to window 2 (Solana Explorer). Scroll the tx instructions list. Highlight a `complete_redemption` (disc 17) instruction. Expand its inner instructions and **point at the CPI call into program `87W54k...iq1oY` — the Ika dWallet program — invoking `approve_message`**. Then cut to window 3 (the dWallet PDA page) and highlight the `authority` field showing `CvHHu36G...91cviv` — our CPI authority PDA. | "Here's the part that's new. The pool's Bitcoin isn't held by a 2-of-3 committee, or a multisig, or a custodian. It's held by an Ika dWallet — and the dWallet's authority is a PDA of *our Solana program*. So when a user redeems BTC, our program CPIs into Ika's `approve_message`, the policy gate is *on-chain code*, not an off-chain signer's config file." |
| **0:50 – 0:60** | Cut to a clean close card (or terminal pane with the four addresses). Show: program ID, dWallet PDA, CPI authority PDA, pool BTC address — and the GitHub URL. | "UTXOpia: shielded BTC on Solana, custody held by an Ika dWallet, policy enforced by the program itself. Pre-alpha disclaimer — Ika devnet uses a mock signer until mainnet, and we say so in the README. Repo and addresses on screen. Thanks." |

---

## Spoken script (clean, no table)

> "UTXOpia makes Bitcoin private on Solana. This is the unified send screen — deposit, transfer, unshield, or redeem all start the same way: just a recipient and an amount.
>
> Recipients are stealth addresses — every send goes to a fresh one-time address, unlinkable on-chain. We use Baby Jubjub spending keys plus Ed25519 viewing keys, EIP-5564 style. There's no public zkBTC token. The amount lives inside a commitment hash.
>
> Every transfer is a Groth16 JoinSplit proof generated in the browser — N inputs to M outputs, ~256-byte proof, ~95k compute units to verify. The Solana program checks the proof, marks nullifiers, inserts new commitments. No middleman saw the amount.
>
> Here's the part that's new. The pool's Bitcoin isn't held by a 2-of-3 committee, or a multisig, or a custodian. It's held by an Ika dWallet — and the dWallet's authority is a PDA of *our Solana program*. So when a user redeems BTC, our program CPIs into Ika's `approve_message`, the policy gate is *on-chain code*, not an off-chain signer's config file.
>
> UTXOpia: shielded BTC on Solana, custody held by an Ika dWallet, policy enforced by the program itself. Pre-alpha disclaimer — Ika devnet uses a mock signer until mainnet, and we say so in the README. Repo and addresses on screen. Thanks."

Word count: ~210 words. Spoken comfortably at 210 wpm = 60 seconds. Slow down by 5–10% if you have headroom.

---

## Screen-action checklist (no narration, for the second take)

- [ ] **0:00** `/send` page visible, wallet connected, devnet network indicator showing.
- [ ] **0:02** Paste `demo.btcpro.sol` (or stealth address) into recipient field.
- [ ] **0:05** Stealth-address resolved indicator appears.
- [ ] **0:08** Mouse hovers over the resolved stealth-address card; tooltip shows the one-time address.
- [ ] **0:15** Type amount (`0.0025`); the JoinSplit dimension badge updates.
- [ ] **0:20** Click **Continue** → review modal opens.
- [ ] **0:23** Begin **Hold-to-Send** gesture; ring fills.
- [ ] **0:27** Proving indicator visible (snarkjs WASM bar).
- [ ] **0:32** Devnet tx signature appears; "View on Explorer" link visible.
- [ ] **0:35** Switch to window 2 (Explorer tab pre-loaded).
- [ ] **0:38** Expand the `complete_redemption` (disc 17) instruction.
- [ ] **0:42** Expand inner instructions; mouse circles the CPI into program `87W54k...iq1oY`.
- [ ] **0:46** Switch to window 3 (Ika dWallet PDA page).
- [ ] **0:48** Mouse circles the `authority = CvHHu36G...91cviv` field.
- [ ] **0:50** Cut to close card / terminal pane with the four addresses + GitHub URL.
- [ ] **0:58** GitHub URL visible until 0:60.

---

## Honesty notes (read before recording)

These are constraints on what the demo can claim, not flexible. Judges respect honesty.

- **The BTC broadcast at the end of the redemption flow may not be a live Bitcoin tx.** Today's reliable, repeatable visual is the on-chain CPI from our `complete_redemption` (disc 17) into the Ika `approve_message` (disc 8). That is what 0:35–0:50 is showing. The backend `IkaSigner` watcher is wired into the dispatch (`UTXOPIA_SIGNING_MODE=ika`), so once the Ika mock signer fills the `MessageApproval` PDA, our watcher assembles the Taproot witness and broadcasts. Whether the mock signer fills it within a live demo window is the unknown — if it does, add 5 seconds and show the Bitcoin testnet tx; if not, do not show a fake one.
- **The mock-signer disclaimer is non-negotiable.** The 0:50–0:60 close mentions it explicitly. Don't drop the line.
- **The on-chain addresses on screen at 0:50 are real and verifiable on devnet Solana Explorer and Bitcoin testnet4** — they're not props.

---

## Asset URLs (for editors / thumbnail makers)

- UTXOpia program: `https://explorer.solana.com/address/G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy?cluster=devnet`
- Ika dWallet PDA: `https://explorer.solana.com/address/DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq?cluster=devnet`
- CPI authority PDA: `https://explorer.solana.com/address/CvHHu36G9srBErXVLFzXR5yRuCS3JcZy2dtZ3a91cviv?cluster=devnet`
- Pool BTC address (testnet4 mempool.space): `https://mempool.space/testnet4/address/tb1p99y96qcldtg6krzv5uvrhmmvh88zmy2dp0kgmjzz56tz7r7vxd3qqn2q95`
- Set-pool-config flip tx: `https://explorer.solana.com/tx/3nEvSGKaa1guMWXeFQ28SaXVzkeLAtxQ5x7z12FZVuEv2gU7NpBurn6KS272CT9paYRsaHbbEEXkVBZD5SSXGkkm?cluster=devnet`
- Program redeploy tx: `https://explorer.solana.com/tx/5jWR2UEf6LtAfWHD9wibtA7yPptAWYmZCLW3pKxGhNetmn7UB287ExnN6CpNpTGcCfNuQT4nQ2vUGWMvzajiMQ1T?cluster=devnet`
