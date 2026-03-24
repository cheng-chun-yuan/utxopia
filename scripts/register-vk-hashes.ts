#!/usr/bin/env bun
/**
 * Register verification key hashes for all compiled JoinSplit circuits.
 * Usage: bun run scripts/register-vk-hashes.ts
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { setupScript, loadState, sendTx } from "./lib/common.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function computeVkHash(vkJson: any): Buffer {
  const parts: string[] = [];
  parts.push(vkJson.vk_alpha_1[0], vkJson.vk_alpha_1[1]);
  parts.push(vkJson.vk_beta_2[0][0], vkJson.vk_beta_2[0][1], vkJson.vk_beta_2[1][0], vkJson.vk_beta_2[1][1]);
  parts.push(vkJson.vk_gamma_2[0][0], vkJson.vk_gamma_2[0][1], vkJson.vk_gamma_2[1][0], vkJson.vk_gamma_2[1][1]);
  parts.push(vkJson.vk_delta_2[0][0], vkJson.vk_delta_2[0][1], vkJson.vk_delta_2[1][0], vkJson.vk_delta_2[1][1]);
  for (const ic of vkJson.IC) parts.push(ic[0], ic[1]);
  const serialized = parts.map(x => Buffer.from(BigInt(x).toString(16).padStart(64, "0"), "hex"));
  return crypto.createHash("sha256").update(Buffer.concat(serialized)).digest();
}

async function main() {
  const { conn, authority, programId, poolState } = setupScript();
  console.log("Program:", programId.toBase58());

  const buildDir = path.join(ROOT, "circuits/build");
  const circuits = fs.readdirSync(buildDir)
    .filter(d => d.startsWith("joinsplit_"))
    .map(d => d.match(/^joinsplit_(\d+)x(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => [parseInt(m[1]), parseInt(m[2])] as [number, number])
    .sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[0] - b[0]);

  for (const [nIn, nOut] of circuits) {
    const name = `joinsplit_${nIn}x${nOut}`;
    const vkPath = path.join(buildDir, name, `${name}.vkey.json`);
    if (!fs.existsSync(vkPath)) { console.log(`  ${name}: no vkey, skip`); continue; }

    const [vkRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk_registry"), Buffer.from([nIn]), Buffer.from([nOut])], programId,
    );
    const existing = await conn.getAccountInfo(vkRegistry);
    if (existing?.data?.length && existing.data[0] === 0x14) { console.log(`  ${name}: registered`); continue; }

    const vkHash = computeVkHash(JSON.parse(fs.readFileSync(vkPath, "utf-8")));
    const data = Buffer.alloc(35);
    data[0] = 11; // INIT_VK_REGISTRY
    data[1] = nIn;
    data[2] = nOut;
    vkHash.copy(data, 3);

    const sig = await sendTx(conn, authority, new TransactionInstruction({
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: vkRegistry, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId, data,
    }));
    console.log(`  ${name}: registered (${sig.slice(0, 16)}...)`);
  }
  console.log("Done!");
}

main().catch(err => { console.error("Error:", err); process.exit(1); });
