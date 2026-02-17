import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_CONFIG } from "../src/config";

async function main() {
  const connection = new Connection("https://solana-devnet.g.alchemy.com/v2/y1zYW-ovVofq7OzZo0Z6IHenRnyq_Pbd");
  
  const commitmentTreePda = new PublicKey(DEVNET_CONFIG.commitmentTreePda);
  console.log("Fetching commitment tree from:", commitmentTreePda.toBase58());
  
  const accountInfo = await connection.getAccountInfo(commitmentTreePda);
  if (!accountInfo) {
    console.log("Account not found!");
    return;
  }
  
  console.log("Account data length:", accountInfo.data.length);
  
  // Parse the commitment tree structure
  // Layout: discriminator(1) + bump(1) + next_index(8) + current_root(32) + root_history(32*16) + frontier(32*20) + commitments(32*1M)
  const data = accountInfo.data;
  
  // Read next_index (u64 little-endian at offset 2)
  const nextIndex = data.readBigUInt64LE(2);
  console.log("Next index:", nextIndex.toString());
  
  // Read current_root (32 bytes at offset 10)
  const currentRoot = data.slice(10, 42);
  const rootHex = Buffer.from(currentRoot).toString("hex");
  console.log("On-chain current root:", rootHex);
  
  // Compare with API root
  const apiRoot = "02285c26c110d1c24cc1ee66990da702840c72a27fed028a70444aca201c2814";
  console.log("API computed root:    ", apiRoot);
  console.log("Roots match:", rootHex === apiRoot);
}

main().catch(console.error);
