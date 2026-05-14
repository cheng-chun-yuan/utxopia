"use client";

import { Suspense, useState, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, FileCheck, ExternalLink, Loader2 } from "lucide-react";
import { getNetworkConfig } from "@/lib/network-config";
import { cn } from "@/lib/utils";

/**
 * Proof of Innocence — user-facing page for `attest_poi` (disc 22).
 *
 * Flow:
 *   1. User pastes (or picks) a commitment in decimal or hex
 *   2. Page fetches inclusion proof from the backend's PoI service
 *      (`/api/poi/inclusion?commitment=...` on `BACKEND_API_URL`)
 *   3. Generates Groth16 PoI proof in the browser
 *   4. POSTs proof + commitment to `/api/attest-poi`, which signs + submits
 *      `attest_poi` (disc 22) as the relayer
 *   5. Shows the resulting attestation event signature
 *
 * Privacy note: the attest_poi public input includes the commitment in clear,
 * so anyone consuming the attestation event sees which commitment was tagged
 * innocent. The relayer hides the user's Solana identity from the event but
 * doesn't hide the commitment itself. Phase 3d (commitment-hiding PoI) is on
 * the roadmap if this trade-off matters for a given use case.
 *
 * Note on the route: `/prove` is taken by the manual SPV-verify widget, so
 * this PoI flow lives at `/poi` instead.
 */
function PoIPageInner() {
  const cfg = useMemo(() => {
    try {
      return getNetworkConfig();
    } catch {
      return null;
    }
  }, []);
  const backendUrl = cfg?.backend.url ?? "";
  const clusterParam = cfg?.solana.rpcUrl?.includes("devnet") ? "?cluster=devnet" : "";

  const [commitmentInput, setCommitmentInput] = useState("");
  const [hideCommitment, setHideCommitment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState<
    "idle" | "fetching" | "proving" | "submitting" | "done"
  >("idle");
  const [result, setResult] = useState<
    | {
        kind: "ok";
        signature: string;
        associationRoot: string;
        /** Only set when the user attested with hidden mode. */
        hidden?: { blindedId: string; nonce: string };
      }
    | { kind: "err"; message: string }
    | null
  >(null);

  /** Accept decimal ("123…") or hex ("0xabc…" / "abc…"). Returns bigint. */
  function parseCommitment(raw: string): bigint {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("commitment is required");
    if (trimmed.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(trimmed)) {
      const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
      if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("invalid hex commitment");
      return BigInt("0x" + hex);
    }
    if (!/^\d+$/.test(trimmed)) throw new Error("commitment must be decimal or hex");
    return BigInt(trimmed);
  }

  function bigintToHex32(value: bigint): string {
    const h = value.toString(16);
    if (h.length > 64) throw new Error("commitment exceeds 32 bytes");
    return h.padStart(64, "0");
  }

  async function handleProve() {
    setSubmitting(true);
    setResult(null);
    try {
      const commitment = parseCommitment(commitmentInput);
      if (!backendUrl) throw new Error("backend URL missing from network config");

      // 1. Fetch inclusion proof
      setStage("fetching");
      const {
        fetchPoIInclusion,
        generatePoIProof,
        generateHiddenPoIProof,
        generateHiddenPoINonce,
        computeBlindedId,
        bytesToHex,
      } = await import("@utxopia/sdk");
      const inclusion = await fetchPoIInclusion(backendUrl, commitment);
      if (!inclusion) {
        throw new Error(
          "commitment is not in the current association set. " +
          "Only commitments tagged by the curator can be attested.",
        );
      }

      // 2. Generate Groth16 PoI proof in-browser. Hidden mode swaps the
      //    public commitment input for a Poseidon(commitment, nonce) blind
      //    so chain watchers can't link the attestation back to a specific
      //    commitment.
      setStage("proving");
      let proofBytesHex: string;
      let attestPayload: { commitment: string; proofBytes: string } | { blindedId: string; proofBytes: string };
      let nonceHex: string | undefined;
      let blindedIdHex: string | undefined;
      if (hideCommitment) {
        const nonce = generateHiddenPoINonce();
        const proofData = await generateHiddenPoIProof({
          associationRoot: inclusion.associationRoot,
          commitment,
          nonce,
          pathElements: inclusion.pathElements,
          pathIndices: inclusion.pathIndices,
        });
        const blindedId = await computeBlindedId(commitment, nonce);
        proofBytesHex = bytesToHex(proofData.proof);
        blindedIdHex = blindedId.toString(16).padStart(64, "0");
        nonceHex = nonce.toString(16).padStart(64, "0");
        attestPayload = { blindedId: blindedIdHex, proofBytes: proofBytesHex };
      } else {
        const proofData = await generatePoIProof({
          associationRoot: inclusion.associationRoot,
          commitment,
          pathElements: inclusion.pathElements,
          pathIndices: inclusion.pathIndices,
        });
        proofBytesHex = bytesToHex(proofData.proof);
        attestPayload = { commitment: bigintToHex32(commitment), proofBytes: proofBytesHex };
      }

      // 3. Submit via relayer
      setStage("submitting");
      const endpoint = hideCommitment ? "/api/attest-poi-hidden" : "/api/attest-poi";
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attestPayload),
      });
      const body = (await resp.json()) as {
        ok: boolean;
        signature?: string;
        error?: string;
      };
      if (!resp.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }

      setStage("done");
      setResult({
        kind: "ok",
        signature: body.signature ?? "",
        associationRoot: inclusion.associationRoot.toString(16).padStart(64, "0"),
        hidden:
          hideCommitment && blindedIdHex && nonceHex
            ? { blindedId: blindedIdHex, nonce: nonceHex }
            : undefined,
      });
    } catch (e) {
      setStage("idle");
      setResult({ kind: "err", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  const stageLabel: Record<typeof stage, string> = {
    idle: "Attest innocence",
    fetching: "Fetching inclusion…",
    proving: "Generating ZK proof…",
    submitting: "Submitting attestation…",
    done: "Attestation submitted",
  };

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-[560px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back home
        </Link>
        <span className="text-caption text-gray font-mono">
          PoI · disc 22
        </span>
      </div>

      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-6",
          "w-[560px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10",
        )}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-[10px] bg-success/10">
            <FileCheck className="w-5 h-5 text-success" />
          </div>
          <div>
            <h1 className="text-heading6 text-foreground">Proof of Innocence</h1>
            <p className="text-caption text-gray">
              Attest that a commitment is in the curated association set.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-body2 text-gray-light pl-2 mb-2 block">
              Commitment
            </label>
            <input
              type="text"
              value={commitmentInput}
              onChange={(e) => setCommitmentInput(e.target.value)}
              placeholder="0x… or decimal (BN254 field element)"
              className={cn(
                "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
                "text-body2 font-mono text-foreground placeholder:text-gray",
                "outline-none focus:border-success/40 transition-colors",
              )}
            />
            <p className="text-caption text-gray mt-1 pl-2">
              Accepts a 64-char hex or a decimal bigint.
            </p>
          </div>

          {/* Hide-commitment toggle */}
          <div className="flex items-start justify-between gap-3 p-3 rounded-[12px] border border-gray/15 bg-muted/10">
            <div className="flex-1 min-w-0">
              <div className="text-body2 text-foreground">Hide commitment</div>
              <div className="text-caption text-gray mt-0.5">
                Publish only a Poseidon-blinded ID instead of the
                commitment itself. Share the nonce with your auditor so
                they can verify the binding off-chain.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={hideCommitment}
              onClick={() => setHideCommitment((v) => !v)}
              disabled={submitting}
              className={cn(
                "shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors",
                hideCommitment ? "bg-success" : "bg-muted",
                submitting && "cursor-not-allowed",
              )}
            >
              <span
                className={cn(
                  "block w-5 h-5 rounded-full bg-background transition-transform",
                  hideCommitment ? "translate-x-4" : "translate-x-0",
                )}
              />
            </button>
          </div>

          <button
            onClick={handleProve}
            disabled={!commitmentInput.trim() || submitting}
            className="btn-primary w-full"
          >
            {submitting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <FileCheck className="w-5 h-5" />
            )}
            {stageLabel[stage]}
          </button>

          {result?.kind === "ok" && (
            <div className="p-3 rounded-[10px] border border-success/30 bg-success/5 text-caption space-y-2">
              <div className="text-success">Attestation event emitted on-chain.</div>
              <div className="text-gray">
                <div className="text-[10px] uppercase tracking-wider text-gray/50 mb-1">
                  signature
                </div>
                <a
                  href={`https://explorer.solana.com/tx/${result.signature}${clusterParam}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono break-all text-foreground hover:text-success inline-flex items-center gap-1"
                >
                  {result.signature || "(see relayer logs)"}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
              <div className="text-gray">
                <div className="text-[10px] uppercase tracking-wider text-gray/50 mb-1">
                  association root
                </div>
                <div className="font-mono break-all text-foreground/70">
                  {result.associationRoot}
                </div>
              </div>
              {result.hidden && (
                <div className="pt-2 mt-2 border-t border-success/10 space-y-2">
                  <div className="text-gray">
                    <div className="text-[10px] uppercase tracking-wider text-gray/50 mb-1">
                      blinded ID (on-chain public input)
                    </div>
                    <div className="font-mono break-all text-foreground/70">
                      {result.hidden.blindedId}
                    </div>
                  </div>
                  <div className="text-gray">
                    <div className="text-[10px] uppercase tracking-wider text-warning/80 mb-1">
                      nonce — share with your auditor to verify
                    </div>
                    <div className="font-mono break-all text-warning/90 select-all">
                      {result.hidden.nonce}
                    </div>
                  </div>
                  <p className="text-[10px] text-gray/60">
                    Auditor verification: <code className="font-mono">computeBlindedId(commitment, nonce)</code> should equal the blinded ID above.
                  </p>
                </div>
              )}
            </div>
          )}
          {result?.kind === "err" && (
            <div className="p-3 rounded-[10px] border border-error/30 bg-error/5 text-caption text-error">
              {result.message}
            </div>
          )}

          <div className="text-caption text-gray pt-3 border-t border-gray/10 space-y-2">
            <p>
              <span className="text-warning">⚠ Privacy note:</span> the
              attestation event publishes the commitment in clear. Anyone
              watching the on-chain attestation stream can link the commitment
              to "I claim this is innocent." The relayer hides your Solana
              identity but not the commitment itself.
            </p>
            <p>
              Commitment-hiding PoI (Phase 3d) is on the roadmap if your use
              case requires the linkage to stay private.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function PoIPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
          <Loader2 className="w-12 h-12 text-gray/40 animate-spin" />
        </main>
      }
    >
      <PoIPageInner />
    </Suspense>
  );
}
