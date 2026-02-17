/**
 * Derive Taproot address from FROST group public key
 *
 * Usage: bun run scripts/derive_address.ts [pubkey]
 */

import { bech32m } from "bech32";

// Default: Read from config/group_pubkey.txt
const GROUP_PUBKEY = process.argv[2] ||
    Bun.file("config/group_pubkey.txt").text().then(t => t.trim());

async function deriveTaprootAddress(pubkeyHex: string, network: "mainnet" | "testnet" = "testnet"): Promise<string> {
    // Convert hex to bytes
    const pubkeyBytes = Buffer.from(pubkeyHex, "hex");

    if (pubkeyBytes.length !== 32) {
        throw new Error(`Invalid x-only public key length: expected 32 bytes, got ${pubkeyBytes.length}`);
    }

    // Bech32m encode for Taproot (BIP-350)
    // HRP: "bc" for mainnet, "tb" for testnet
    const hrp = network === "mainnet" ? "bc" : "tb";

    // Witness version 1 + data
    const words = bech32m.toWords(pubkeyBytes);
    words.unshift(1); // Witness version 1 for Taproot

    return bech32m.encode(hrp, words);
}

async function main() {
    const pubkey = typeof GROUP_PUBKEY === "string" ? GROUP_PUBKEY : await GROUP_PUBKEY;

    console.log("FROST Group Key Configuration");
    console.log("=============================");
    console.log();
    console.log("Group Public Key (x-only, 32 bytes hex):");
    console.log(`  ${pubkey}`);
    console.log();

    const testnetAddress = await deriveTaprootAddress(pubkey, "testnet");
    const mainnetAddress = await deriveTaprootAddress(pubkey, "mainnet");

    console.log("Taproot Addresses:");
    console.log(`  Testnet: ${testnetAddress}`);
    console.log(`  Mainnet: ${mainnetAddress}`);
    console.log();
    console.log("To test deposits:");
    console.log(`  1. Get testnet BTC from a faucet`);
    console.log(`  2. Send to: ${testnetAddress}`);
    console.log(`  3. The FROST signers can sign to spend from this address`);
}

main().catch(console.error);
