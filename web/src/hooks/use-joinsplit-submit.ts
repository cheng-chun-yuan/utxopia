"use client";

/**
 * useJoinSplitSubmit — wraps proof generation + relay submission into a single hook.
 * Used by PaymentWizard for all 3 flows.
 */

import { useState, useCallback } from "react";
import { useProver } from "@/hooks/use-prover";
import type { TransferParams } from "@/hooks/use-build-transfer-params";
import { TOKEN_2022_PROGRAM_ID_STR } from "@/lib/btc-constants";

export type SubmitStatus = "idle" | "preparing" | "processing" | "submitting" | "success" | "error";

export function useJoinSplitSubmit() {
  const prover = useProver();
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (params: TransferParams, redeemAmountSats?: bigint) => {
    setStatus("preparing");
    setStatusMessage("Preparing transaction...");
    setError(null);
    setTxSignature(null);

    try {
      const { bytesToHex, UTXOpiaClient, getConfig } = await import("@utxopia/sdk");

      // Initialize prover if needed
      if (!prover.isInitialized) {
        await prover.initialize();
      }

      // Generate ZK proof
      setStatus("processing");
      setStatusMessage("Processing...");
      const { proof: proofData, proofBytes } = await prover.generateProof(params.proofInputs);

      // Extract public signals
      setStatus("submitting");
      setStatusMessage("Submitting transaction...");

      const publicSignals = proofData.publicInputs;
      const nInputs = params.proofInputs.nInputs;
      const nOutputs = params.proofInputs.nOutputs;

      const merkleRootHex = BigInt(publicSignals[0]).toString(16).padStart(64, "0");
      const boundParamsHashHex = BigInt(publicSignals[1]).toString(16).padStart(64, "0");
      const nullifierHexes = publicSignals.slice(2, 2 + nInputs).map(
        (s: string) => BigInt(s).toString(16).padStart(64, "0"),
      );
      const commitmentHexes = publicSignals.slice(2 + nInputs, 2 + nInputs + nOutputs).map(
        (s: string) => BigInt(s).toString(16).padStart(64, "0"),
      );

      const relayClient = UTXOpiaClient.isInitialized
        ? UTXOpiaClient.instance()
        : await UTXOpiaClient.init();

      const commonFields = {
        nInputs,
        nOutputs,
        proof: bytesToHex(proofBytes),
        merkleRoot: merkleRootHex,
        boundParamsHash: boundParamsHashHex,
        nullifiers: nullifierHexes,
        commitmentsOut: commitmentHexes,
      };

      let relayResult: { success: boolean; signature?: string; error?: string };

      if (params.relayMode === "redeem") {
        const treeStealthData = params.stealthDataArrays.slice(0, -1);
        const requestNonce = BigInt(Date.now());
        relayResult = await relayClient.submitToRelay({
          ...commonFields,
          mode: "redeem",
          stealthData: treeStealthData.map((sd) => bytesToHex(sd)),
          redeemAmounts: [(redeemAmountSats ?? 0n).toString()],
          btcScripts: [bytesToHex(params.btcScriptPubKey!)],
          requestNonces: [requestNonce.toString()],
        });
      } else if (params.relayMode === "unshield") {
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const { PublicKey } = await import("@solana/web3.js");
        const recipientPubkey = new PublicKey(params.unshieldRecipientAddress!);
        const zkbtcMint = new PublicKey(getConfig().zkbtcMint);
        const TOKEN_2022_PID = new PublicKey(TOKEN_2022_PROGRAM_ID_STR);
        const recipientTokenAccount = getAssociatedTokenAddressSync(
          zkbtcMint, recipientPubkey, false, TOKEN_2022_PID,
        );
        const treeStealthData = params.stealthDataArrays.slice(0, -1);

        // Compute unshield amount from proof outputs (last output is unshield)
        const unshieldAmount = Number(params.proofInputs.outputs[params.proofInputs.outputs.length - 1].value);

        relayResult = await relayClient.submitToRelay({
          ...commonFields,
          mode: "unshield",
          stealthData: treeStealthData.map((sd) => bytesToHex(sd)),
          unshieldAmounts: [unshieldAmount.toString()],
          recipientAddresses: [recipientPubkey.toBase58()],
          recipientTokenAccounts: [recipientTokenAccount.toBase58()],
        });
      } else {
        // Transfer mode: opportunistically attach sender memos so the sender
        // retains an encrypted, AAD-bound record of their own outgoing
        // history. Encryption is to the sender's own `ovk` (derived from
        // their viewing key) — recipients never see it; no third-party can
        // decrypt without an explicit DelegatedViewKey share. Disable by
        // setting NEXT_PUBLIC_DISABLE_SENDER_MEMOS=1.
        let senderMemosHex: string[] | undefined;
        const memoOptOut = process.env.NEXT_PUBLIC_DISABLE_SENDER_MEMOS === "1";
        const senderKeys = relayClient.keys;
        if (!memoOptOut && senderKeys?.viewingPrivKey) {
          try {
            const { buildSenderMemosForTransact, fetchCommitmentTree, hexToBytes } =
              await import("@utxopia/sdk");
            const { Connection } = await import("@solana/web3.js");
            const { deriveCommitmentTreePDA } = await import("@/lib/solana/pdas");

            const rpcUrl = getConfig().solanaRpcUrl;
            if (!rpcUrl) throw new Error("solanaRpcUrl missing from config");
            const connection = new Connection(rpcUrl, "confirmed");
            const [treePda] = deriveCommitmentTreePDA();

            // fetchCommitmentTree types its `connection` arg as a duck-typed
            // shape that returns `{ data: Uint8Array }`. Solana web3.js
            // Connection returns `{ data: Buffer }`, which is also a
            // Uint8Array at runtime, so this works — cast through unknown to
            // shut TS up.
            const tree = await fetchCommitmentTree(
              connection as unknown as Parameters<typeof fetchCommitmentTree>[0],
              treePda,
            );
            if (tree == null) throw new Error("commitment tree PDA not found");
            const nextIndex = Number(tree.nextIndex);

            const tokenId = params.proofInputs.token;
            const memoOutputs = params.proofInputs.outputs.map((out, i) => ({
              tokenId,
              amount: out.value,
              commitment: hexToBytes(commitmentHexes[i]),
              leafIndex: nextIndex + i,
            }));
            const packed = buildSenderMemosForTransact(senderKeys.viewingPrivKey, memoOutputs);
            senderMemosHex = packed.map((b: Uint8Array) => bytesToHex(b));
          } catch (e) {
            // Sender memos are best-effort: if leaf-index prediction or RPC
            // fails, drop the memo channel for this tx rather than blocking
            // the transfer. The user's outgoing history just has a gap.
            console.warn("[Submit] Skipping sender memos:", e);
            senderMemosHex = undefined;
          }
        }

        relayResult = await relayClient.submitToRelay({
          ...commonFields,
          mode: "transfer",
          stealthData: params.stealthDataArrays.map((sd) => bytesToHex(sd)),
          relayerFeeOutputIndex: params.relayerFeeOutputIndex,
          senderMemos: senderMemosHex,
        });
      }

      if (!relayResult.success) {
        throw new Error(relayResult.error || "Transaction failed");
      }

      setTxSignature(relayResult.signature ?? null);
      setStatus("success");
      setStatusMessage("");

      // Track tx count for Lite/Pro toggle visibility
      try {
        const count = parseInt(localStorage.getItem("utxopia-tx-count") || "0", 10);
        localStorage.setItem("utxopia-tx-count", String(count + 1));
      } catch {};
    } catch (err) {
      console.error("[Submit] Error:", err);
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStatus("error");
      setStatusMessage("");
    }
  }, [prover]);

  const reset = useCallback(() => {
    setStatus("idle");
    setStatusMessage("");
    setTxSignature(null);
    setError(null);
  }, []);

  return { status, statusMessage, txSignature, error, submit, reset };
}
