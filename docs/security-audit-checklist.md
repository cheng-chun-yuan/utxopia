# UTXOpia Security Audit Checklist

> Generated 2026-03-07. Track fixes here.

## CRITICAL (Fix Immediately)

- [x] **C1** Missing proof buffer owner validation in `transact.rs` + `redeem.rs` (proof_source=1)
- [x] **C2** CORS allows any origin by default — require ALLOWED_ORIGIN
- [x] **C3** FROST API key auth disabled by default — require FROST_API_KEY
- [x] **C4** Weak RNG for deposit/withdrawal IDs (16-bit entropy)
- [x] **C5** Command injection in prover `execSync()` with template literals
- [x] **C6** No authentication on backend API endpoints (redeem, stealth, deposits)
- [x] **C7** Missing ECDH verification in relayer fee validation
- [x] **C8** Relayer private key in plaintext env vars (document KMS migration)
- [x] **C9** Unencrypted viewing key serialization allowed without password
- [x] **C10** No rate limiting on FROST signing endpoints

## HIGH (Fix This Sprint)

- [x] **H1** ChadBuffer owner not validated in complete_deposit
- [x] **H2** Complete redemption TX buffer owner not validated
- [x] **H3** mark_processing missing writable validation
- [x] **H4** XOR amount encryption: deterministic, unauthenticated, 64-bit key
- [x] **H5** Weak PBKDF2: 100k-150k iterations → increase to 600k
- [x] **H6** Static PBKDF2 salt "utxopia-v3" → random per-user salt
- [x] **H7** BigInt private keys can't be securely zeroized in JS (document)
- [x] **H8** No replay prevention in FROST signing sessions
- [x] **H9** DKG ceremony secrets unencrypted in memory (1h timeout → 10min)
- [x] **H10** Nullifier missing merkle root binding (document circuit-level binding)
- [x] **H11** Passkey seed stored plaintext in localStorage
- [x] **H12** Passkey PRF uses hardcoded salt
- [x] **H13** Unsafe string slicing on user-controlled stealth data
- [x] **H14** Weak Argon2 default parameters for FROST key encryption
- [x] **H15** Potential AES-GCM nonce reuse in DKG
- [x] **H16** Viewing key delegation lacks cryptographic separation (document)
- [x] **H17** Helius API key exposed client-side

## MEDIUM (Should Fix)

- [x] **M1** Pool update bounds validation (min <= max, max <= 21M BTC) — enforced in propose_pool_update with 48h timelock
- [x] **M2** Missing input validation on /api/redeem
- [x] **M3** SHA256 truncated to 8 bytes for amount key (document)
- [x] **M4** No authentication tag on XOR amount encryption (document)
- [x] **M5** Constant-time compare leaks length info
- [x] **M6** API error messages reveal internal schema details
- [x] **M7** Unvalidated JSON input in stealth data decode
- [x] **M8** No content-security-policy headers on frontend
- [x] **M9** WebSocket messages not schema-validated
- [x] **M10** Hardcoded devnet program IDs as fallbacks

## LOW (Nice to Fix)

- [ ] **L1** Detailed error messages leak internal state
- [ ] **L2** Path traversal in database file handling
- [ ] **L3** println! instead of structured logging in websocket
- [ ] **L4** Silent .ok() error ignoring in storage
- [ ] **L5** Dynamic require() in ClaimForm
- [ ] **L6** Ephemeral keypair not explicitly verified on curve
- [ ] **L7** Poseidon sync initialization footgun
- [ ] **L8** Missing rent exemption explicit checks
- [ ] **L9** Unsafe pointer casts not documented
- [ ] **L10** No input validation on stealth deposit ephemeral pub
