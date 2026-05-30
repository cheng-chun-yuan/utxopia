import { PublicKey } from "@solana/web3.js";

const IKA_PROGRAM = new PublicKey("87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY");
const DWALLET_COMPRESSED_HEX = "0287a1014ea16e42c825026889874902875aec7650b39c2b334a4d04d49b904c76";

const dwalletPub = Buffer.from(DWALLET_COMPRESSED_HEX, "hex");
const payload = Buffer.alloc(2 + dwalletPub.length);
payload.writeUInt16LE(0, 0); // Secp256k1 = 0
dwalletPub.copy(payload, 2);

// Try both single-leaf and chunked variants
const [pda1] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("dwallet"),
    payload.subarray(0, 32),
    payload.subarray(32),
    Buffer.from("attestation"),
  ],
  IKA_PROGRAM,
);
console.log("attestation PDA:", pda1.toBase58());
