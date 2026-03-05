import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PROGRAM_ID = new PublicKey('25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM');
const POOL_STATE = new PublicKey('7Xr7MthZPc7YeHfU5SRmguxovhiDNhfestWgtPruUfjE');

// Read keypair from .env.local
const envContent = fs.readFileSync(path.join(ROOT, 'aegis-app/.env.local'), 'utf-8');
const keypairMatch = envContent.match(/RELAYER_KEYPAIR=(\[.*?\])/);
if (!keypairMatch) throw new Error('RELAYER_KEYPAIR not found in .env.local');
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairMatch[1])));
console.log('Authority:', authority.publicKey.toBase58());

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

function deriveVkRegistryPDA(nInputs, nOutputs) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_registry'), new Uint8Array([nInputs]), new Uint8Array([nOutputs])],
    PROGRAM_ID
  );
}

function computeVkHash(vkJson) {
  const parts = [];
  parts.push(vkJson.vk_alpha_1[0], vkJson.vk_alpha_1[1]);
  parts.push(vkJson.vk_beta_2[0][0], vkJson.vk_beta_2[0][1], vkJson.vk_beta_2[1][0], vkJson.vk_beta_2[1][1]);
  parts.push(vkJson.vk_gamma_2[0][0], vkJson.vk_gamma_2[0][1], vkJson.vk_gamma_2[1][0], vkJson.vk_gamma_2[1][1]);
  parts.push(vkJson.vk_delta_2[0][0], vkJson.vk_delta_2[0][1], vkJson.vk_delta_2[1][0], vkJson.vk_delta_2[1][1]);
  for (const ic of vkJson.IC) {
    parts.push(ic[0], ic[1]);
  }
  const serialized = parts.map(x => {
    const hex = BigInt(x).toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
  });
  const buf = Buffer.concat(serialized);
  return crypto.createHash('sha256').update(buf).digest();
}

// Build list of all circuits that have vkey files
const circuitDirs = fs.readdirSync(path.join(ROOT, 'circuits/build')).filter(d => d.startsWith('joinsplit_'));
const circuits = circuitDirs
  .map(d => {
    const m = d.match(/^joinsplit_(\d+)x(\d+)$/);
    return m ? [parseInt(m[1]), parseInt(m[2])] : null;
  })
  .filter(Boolean)
  .sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[0] - b[0]);

for (const [nIn, nOut] of circuits) {
  const circuitName = `joinsplit_${nIn}x${nOut}`;
  const vkPath = path.join(ROOT, `circuits/build/${circuitName}/${circuitName}.vkey.json`);

  if (!fs.existsSync(vkPath)) {
    console.log(`  ${circuitName}: no vkey.json, skipping`);
    continue;
  }

  const [vkRegistry] = deriveVkRegistryPDA(nIn, nOut);
  const existing = await connection.getAccountInfo(vkRegistry);
  if (existing && existing.data.length > 0 && existing.data[0] === 0x14) {
    console.log(`  ${circuitName}: already registered`);
    continue;
  }

  const vkJson = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));
  const vkHash = computeVkHash(vkJson);
  console.log(`  ${circuitName}: registering VK hash ${vkHash.toString('hex').slice(0,16)}...`);

  const data = Buffer.alloc(35);
  data[0] = 11; // INIT_VK_REGISTRY discriminator
  data[1] = nIn;
  data[2] = nOut;
  vkHash.copy(data, 3);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: POOL_STATE, isSigner: false, isWritable: false },
      { pubkey: vkRegistry, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
  console.log(`  ${circuitName}: registered! tx=${sig.slice(0,20)}...`);
}

console.log('Done!');
