"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, FileCheck, Upload, Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * In-browser Groth16 proof verifier.
 *
 * Lets auditors verify selective-disclosure proofs (ownership, range_sum)
 * or PoI proofs without installing bun + snarkjs locally. The page accepts
 * either:
 *   - a known circuit name (vkey fetched from the local /circuits CDN), or
 *   - a custom uploaded vkey JSON
 *
 * Plus a proof.json (snarkjs's `{ pi_a, pi_b, pi_c, protocol, curve }`
 * shape) and the matching public signals (`string[]`). Verification runs
 * via `snarkjs.groth16.verify` entirely in the browser.
 */

type KnownCircuit =
  | "proof_of_innocence"
  | "ownership"
  | "range_sum"
  | "range_sum_4"
  | "custom";

const KNOWN_CIRCUITS: { value: KnownCircuit; label: string }[] = [
  { value: "ownership", label: "ownership — Phase 4 threshold proof" },
  { value: "range_sum", label: "range_sum — N=8 range-sum" },
  { value: "range_sum_4", label: "range_sum_4 — N=4 range-sum" },
  { value: "proof_of_innocence", label: "proof_of_innocence — PoI" },
  { value: "custom", label: "Custom — upload your own vkey.json" },
];

type VerifyResult =
  | { kind: "ok"; publicInputs: string[] }
  | { kind: "fail"; publicInputs: string[] }
  | { kind: "err"; message: string };

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

export default function VerifyProofPage() {
  const [circuit, setCircuit] = useState<KnownCircuit>("ownership");
  const [proofJson, setProofJson] = useState("");
  const [publicJson, setPublicJson] = useState("");
  const [customVkey, setCustomVkey] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const cdnBase = useMemo(() => {
    const envBase = process.env.NEXT_PUBLIC_CIRCUIT_CDN_URL ?? "";
    return envBase ? `${envBase}/circuits/groth16` : "/circuits/groth16";
  }, []);

  function pasteFromFile(setter: (s: string) => void) {
    return async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      setter(await f.text());
      e.target.value = "";
    };
  }

  async function loadVkey(): Promise<unknown> {
    if (circuit === "custom") {
      if (!customVkey.trim()) throw new Error("paste or upload a vkey.json");
      return JSON.parse(customVkey);
    }
    const url = `${cdnBase}/${circuit}/${circuit}.vkey.json`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `couldn't fetch ${url} (HTTP ${resp.status}). Set NEXT_PUBLIC_CIRCUIT_CDN_URL ` +
          `or run \`bash circuits/scripts/build-aux.sh ${circuit}\` then copy the vkey to web/public/circuits/groth16/`,
      );
    }
    return resp.json();
  }

  async function handleVerify() {
    setVerifying(true);
    setResult(null);
    try {
      // 1. Parse proof + public inputs.
      const proof = JSON.parse(proofJson) as unknown;
      const publicSignals = JSON.parse(publicJson) as unknown;
      if (typeof proof !== "object" || proof === null) {
        throw new Error("proof must be a JSON object");
      }
      if (!isStringArray(publicSignals)) {
        throw new Error("public inputs must be a JSON array of decimal strings");
      }

      // 2. Resolve the verifying key (fetched or pasted).
      const vkey = await loadVkey();

      // 3. Verify in-browser. Lazy-load the SDK helper (which itself
      //    lazy-loads snarkjs) so this page doesn't blow up the main bundle
      //    for users who never visit it.
      const { verifyGroth16Proof } = await import("@utxopia/sdk/prover/web");
      const ok = await verifyGroth16Proof(vkey, publicSignals, proof);
      setResult(ok ? { kind: "ok", publicInputs: publicSignals } : { kind: "fail", publicInputs: publicSignals });
    } catch (e) {
      setResult({ kind: "err", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setVerifying(false);
    }
  }

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4 py-12">
      <div className="w-full max-w-[640px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back home
        </Link>
        <span className="text-caption text-gray font-mono">in-browser groth16</span>
      </div>

      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-6",
          "w-[640px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10",
        )}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-[10px] bg-success/10">
            <FileCheck className="w-5 h-5 text-success" />
          </div>
          <div>
            <h1 className="text-heading6 text-foreground">Verify a Groth16 proof</h1>
            <p className="text-caption text-gray">
              Auditor tool — checks ownership / range-sum / PoI proofs without bun + snarkjs locally.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Circuit picker */}
          <div>
            <label className="text-body2 text-gray-light pl-2 mb-2 block">
              Circuit
            </label>
            <select
              value={circuit}
              onChange={(e) => setCircuit(e.target.value as KnownCircuit)}
              className={cn(
                "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
                "text-body2 font-mono text-foreground",
                "outline-none focus:border-success/40 transition-colors",
              )}
            >
              {KNOWN_CIRCUITS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* Custom vkey input (only when "custom") */}
          {circuit === "custom" && (
            <FileTextArea
              label="vkey.json"
              value={customVkey}
              onChange={setCustomVkey}
              onFile={pasteFromFile(setCustomVkey)}
              placeholder='{"protocol":"groth16","curve":"bn128",...}'
              rows={4}
            />
          )}

          {/* Proof */}
          <FileTextArea
            label="proof.json"
            value={proofJson}
            onChange={setProofJson}
            onFile={pasteFromFile(setProofJson)}
            placeholder='{"pi_a":[...],"pi_b":[[...],[...]],"pi_c":[...],"protocol":"groth16","curve":"bn128"}'
            rows={5}
          />

          {/* Public inputs */}
          <FileTextArea
            label="public.json (public inputs)"
            value={publicJson}
            onChange={setPublicJson}
            onFile={pasteFromFile(setPublicJson)}
            placeholder='["12345...","67890...",...]'
            rows={3}
          />

          <button
            onClick={handleVerify}
            disabled={!proofJson || !publicJson || verifying}
            className="btn-primary w-full"
          >
            {verifying ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileCheck className="w-5 h-5" />}
            {verifying ? "Verifying…" : "Verify"}
          </button>

          {result?.kind === "ok" && (
            <div className="p-3 rounded-[10px] border border-success/30 bg-success/5 text-caption space-y-2">
              <div className="flex items-center gap-2 text-success font-semibold">
                <Check className="w-4 h-4" />
                Proof valid
              </div>
              <PublicInputs values={result.publicInputs} />
            </div>
          )}
          {result?.kind === "fail" && (
            <div className="p-3 rounded-[10px] border border-error/30 bg-error/5 text-caption space-y-2">
              <div className="flex items-center gap-2 text-error font-semibold">
                <X className="w-4 h-4" />
                Proof does NOT verify against this vkey + public inputs
              </div>
              <PublicInputs values={result.publicInputs} />
            </div>
          )}
          {result?.kind === "err" && (
            <div className="p-3 rounded-[10px] border border-error/30 bg-error/5 text-caption text-error">
              {result.message}
            </div>
          )}

          <p className="text-caption text-gray pt-3 border-t border-gray/10">
            Verification is purely client-side. Nothing is sent to a server.
          </p>
        </div>
      </div>
    </main>
  );
}

function FileTextArea({
  label,
  value,
  onChange,
  onFile,
  placeholder,
  rows,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  rows: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between pl-2 pr-1 mb-2">
        <label className="text-body2 text-gray-light">{label}</label>
        <label className="inline-flex items-center gap-1 text-caption text-gray hover:text-gray-light cursor-pointer">
          <Upload className="w-3 h-3" />
          Upload
          <input
            type="file"
            accept=".json,application/json,text/plain"
            className="hidden"
            onChange={onFile}
          />
        </label>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={cn(
          "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
          "text-[11px] font-mono text-foreground placeholder:text-gray/40",
          "outline-none focus:border-success/40 transition-colors resize-y",
        )}
      />
    </div>
  );
}

function PublicInputs({ values }: { values: string[] }) {
  return (
    <div className="text-gray">
      <div className="text-[10px] uppercase tracking-wider text-gray/50 mb-1">
        public inputs ({values.length})
      </div>
      <div className="font-mono text-[11px] space-y-0.5 max-h-40 overflow-y-auto">
        {values.map((v, i) => (
          <div key={i} className="break-all">
            <span className="text-gray/40">[{i}]</span> {v}
          </div>
        ))}
      </div>
    </div>
  );
}
