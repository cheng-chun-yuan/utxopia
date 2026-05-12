import { bech32m } from 'bech32';
import { createHash, randomBytes } from 'crypto';
import * as circomlibjs from 'circomlibjs';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const { ed25519, x25519 } = await import('@noble/curves/ed25519.js');

const stealthHex = 'ec933d02763bc1fec9ef60c542d51593b5fd44cbee02bf0f11fe7f411c441f9fe417bbb0699ad6f29c2200e193d9f83e5b91b0a579953e2662db942c465deca3';
const stealthBytes = Buffer.from(stealthHex, 'hex');
const spendingPub = stealthBytes.slice(0, 32);
const viewingPub = stealthBytes.slice(32, 64);

console.log('Spending PubKey (BJJ):', spendingPub.toString('hex'));
console.log('Viewing PubKey (Ed25519):', viewingPub.toString('hex'));

// secp256k1 generator x-coordinate as internal key (test key)
const INTERNAL_KEY = Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');

// Generate ephemeral Ed25519 keypair
const ephemeralPriv = randomBytes(32);
const ephemeralPub = ed25519.getPublicKey(ephemeralPriv);
console.log('\nEphemeral PubKey:', Buffer.from(ephemeralPub).toString('hex'));

// X25519 ECDH: derive shared secret
const sharedSecret = x25519.getSharedSecret(ephemeralPriv, viewingPub);

// Derive stealth scalar
// LOAD-BEARING: see sdk/src/stealth.ts for the full note on why this stays
// as 'Aegis-stealth-v1' despite the project rename to UTXOpia.
const STEALTH_KEY_DOMAIN = new TextEncoder().encode('Aegis-stealth-v1');
const hi = new Uint8Array(sharedSecret.length + STEALTH_KEY_DOMAIN.length);
hi.set(sharedSecret, 0);
hi.set(STEALTH_KEY_DOMAIN, sharedSecret.length);
const stealthScalarHash = sha256(hi);

const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
let stealthScalar = 0n;
for (let i = 0; i < 32; i++) {
  stealthScalar = (stealthScalar << 8n) | BigInt(stealthScalarHash[i]);
}
stealthScalar = stealthScalar % BN254_PRIME;

// Baby Jubjub point arithmetic
const babyJub = await circomlibjs.buildBabyjub();
const poseidon = await circomlibjs.buildPoseidon();
const F = babyJub.F;

const spendX = F.fromRprLE(spendingPub, 0);
const Base8 = babyJub.Base8;
const scalarPoint = babyJub.mulPointEscalar(Base8, stealthScalar);

// Decompress: y^2 = (1 - ax^2) / (1 - dx^2)
const a = F.e(168700n);
const d = F.e(168696n);
const x2 = F.square(spendX);
const num = F.sub(F.one, F.mul(a, x2));
const den = F.sub(F.one, F.mul(d, x2));
const y2 = F.div(num, den);
const spendY = F.sqrt(y2);

if (!spendY) {
  console.error('Cannot decompress spending key - invalid point');
  process.exit(1);
}

const spendPoint = [spendX, spendY];
const stealthPub = babyJub.addPoint(spendPoint, scalarPoint);

// commitment = Poseidon(stealthPub.x)
const commitmentF = poseidon([stealthPub[0]]);
const commitmentBigint = BigInt(poseidon.F.toString(commitmentF));

const commitment = Buffer.alloc(32);
let temp = commitmentBigint;
for (let i = 31; i >= 0; i--) {
  commitment[i] = Number(temp & 0xffn);
  temp = temp >> 8n;
}

console.log('Commitment:', commitment.toString('hex'));

// ============================================================
// Proper BIP-341 Taproot address derivation using secp256k1
// ============================================================

// 1. Compute tagged hash: tweak = H_TapTweak(internal_key || commitment)
const tagHash = createHash('sha256').update('TapTweak').digest();
const tweakInput = Buffer.concat([tagHash, tagHash, INTERNAL_KEY, commitment]);
const tweak = createHash('sha256').update(tweakInput).digest();

// 2. Convert tweak to scalar (big-endian)
let tweakScalar = 0n;
for (let i = 0; i < 32; i++) {
  tweakScalar = (tweakScalar << 8n) | BigInt(tweak[i]);
}

// 3. BIP-341: Q = lift_x(P) + t*G
//    lift_x recovers full point from x-only key (even y per BIP-340)
const internalPoint = secp256k1.Point.fromHex(
  '02' + INTERNAL_KEY.toString('hex') // 0x02 prefix = even y
);
const tweakPoint = secp256k1.Point.BASE.multiply(tweakScalar);
const outputPoint = internalPoint.add(tweakPoint);

// 4. x-only output key (drop prefix byte from compressed hex)
const outputKeyHex = outputPoint.toHex(true); // 33-byte compressed hex string
const outputKey = Buffer.from(outputKeyHex.slice(2), 'hex'); // drop "02"/"03" prefix

// 5. Encode as bech32m Taproot address
const words = bech32m.toWords(outputKey);
const btcAddress = bech32m.encode('tb', [1, ...words]);

console.log('\n========================================');
console.log('BTC Deposit Address (testnet):', btcAddress);
console.log('========================================');
console.log('\nSave these for the E2E test:');
console.log('  Ephemeral pub:', Buffer.from(ephemeralPub).toString('hex'));
console.log('  Commitment:', commitment.toString('hex'));
console.log('  Output key:', Buffer.from(outputKey).toString('hex'));
