"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Copy,
  KeyRound,
  LogIn,
  RefreshCw,
  Wallet,
} from "lucide-react";
import {
  buildGoogleZkLoginUrl,
  clearSuiZkLoginSession,
  consumeSuiZkLoginCallback,
  createSuiZkLoginSession,
  getSuiAdapter,
  getSuiZkLoginSession,
  type SuiZkLoginSession,
} from "@/lib/sui/client";
import {
  createRandomSuiUtxopiaAuthPreview,
  type SuiUtxopiaAuthPreview,
} from "@/lib/sui/utxopia-auth";
import { cn } from "@/lib/utils";

type AuthMode = "wallet" | "zklogin";

interface BrowserSuiWallet {
  requestPermissions?: () => Promise<void>;
  getAccounts?: () => Promise<string[]>;
}

declare global {
  interface Window {
    suiWallet?: BrowserSuiWallet;
  }
}

export function SuiAuthPanel() {
  const [mode, setMode] = useState<AuthMode>("zklogin");
  const [address, setAddress] = useState<string | null>(null);
  const [session, setSession] = useState<SuiZkLoginSession | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const [ptbBytes, setPtbBytes] = useState<number | null>(null);
  const [authPreview, setAuthPreview] = useState<SuiUtxopiaAuthPreview | null>(null);
  const [authPreviewStatus, setAuthPreviewStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const hasGoogleClient = Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);
  const hasSaltServer = Boolean(process.env.NEXT_PUBLIC_ZKLOGIN_SALT_SERVER_URL);
  const hasProver = Boolean(process.env.NEXT_PUBLIC_ZKLOGIN_PROVER_URL);

  useEffect(() => {
    setSession(getSuiZkLoginSession());
    let cancelled = false;
    async function run() {
      try {
        const callback = await consumeSuiZkLoginCallback();
        if (cancelled) return;
        if (callback.error) {
          setStatus("error");
          setMessage(callback.error);
          return;
        }
        if (callback.jwt) {
          setMode("zklogin");
          setAddress(callback.address);
          setStatus(callback.address ? "ready" : "idle");
          setMessage(
            callback.address
              ? "zkLogin JWT received and address derived."
              : "zkLogin JWT received. Configure the salt server to derive a stable Sui address.",
          );
        }
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function preview() {
      try {
        const adapter = getSuiAdapter();
        const tx = await adapter.buildShieldTransaction({
          recipient: address ?? "0x0",
          tokenId: "zkSUI",
          amount: 1n,
          metadata: {
            commitment: "11".repeat(32),
            newRoot: "22".repeat(32),
          },
        });
        if (!cancelled) setPtbBytes(tx.bytes.length);
      } catch {
        if (!cancelled) setPtbBytes(null);
      }
    }
    preview();
    return () => {
      cancelled = true;
    };
  }, [address]);

  const zkLoginReadiness = useMemo(() => [
    { label: "Google OAuth client", ok: hasGoogleClient },
    { label: "Salt server", ok: hasSaltServer },
    { label: "Proof service", ok: hasProver },
  ], [hasGoogleClient, hasSaltServer, hasProver]);

  async function connectSuiWallet() {
    setMode("wallet");
    setStatus("loading");
    setMessage("");
    try {
      const wallet = window.suiWallet;
      if (!wallet?.requestPermissions || !wallet.getAccounts) {
        throw new Error("No browser Sui wallet detected. Use zkLogin or install a Sui wallet extension.");
      }
      await wallet.requestPermissions();
      const accounts = await wallet.getAccounts();
      if (!accounts[0]) throw new Error("Sui wallet returned no accounts.");
      setAddress(accounts[0]);
      setStatus("ready");
      setMessage("Sui wallet connected.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startZkLogin() {
    setMode("zklogin");
    setStatus("loading");
    setMessage("");
    try {
      const nextSession = await createSuiZkLoginSession();
      setSession(nextSession);
      window.location.href = buildGoogleZkLoginUrl(nextSession);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function generateRandomUtxopiaKeys() {
    setAuthPreviewStatus("loading");
    try {
      const preview = await createRandomSuiUtxopiaAuthPreview({
        account: address ?? "agent-browser-random-signature",
        chain: "sui",
        network: "sui-regtest",
      });
      setAuthPreview(preview);
      setAuthPreviewStatus("ready");
    } catch (error) {
      setAuthPreviewStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function resetZkLogin() {
    clearSuiZkLoginSession();
    setSession(null);
    setAddress(null);
    setStatus("idle");
    setMessage("");
  }

  return (
    <section className="rounded-lg border border-gray/10 bg-muted/10 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray">
            Sui access
          </div>
          <h2 className="mt-1 text-xl font-semibold text-foreground">Wallet or zkLogin</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray">
            Use a Sui wallet for operator testing, or start a Google zkLogin session for walletless onboarding. zkLogin can sign UTXOpia Sui PTBs once salt and proof services are configured.
          </p>
        </div>
        <Status state={status} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-md border border-gray/10 bg-background/35 p-1">
            <ModeButton active={mode === "zklogin"} icon={<KeyRound className="h-4 w-4" />} onClick={() => setMode("zklogin")}>
              zkLogin
            </ModeButton>
            <ModeButton active={mode === "wallet"} icon={<Wallet className="h-4 w-4" />} onClick={() => setMode("wallet")}>
              Wallet
            </ModeButton>
          </div>

          {mode === "zklogin" ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={startZkLogin}
                disabled={status === "loading"}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-sui px-4 py-3 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                <LogIn className="h-4 w-4" />
                Continue with Google
              </button>
              <button
                type="button"
                onClick={resetZkLogin}
                className="w-full rounded-md border border-gray/15 px-4 py-2.5 text-xs font-semibold text-gray transition-colors hover:border-gray/30 hover:text-foreground"
              >
                Reset session
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={connectSuiWallet}
              disabled={status === "loading"}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-4 py-3 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              <Wallet className="h-4 w-4" />
              Connect Sui wallet
            </button>
          )}
        </div>

        <div className="rounded-md border border-gray/10 bg-background/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-foreground">Active Sui signer</span>
            {address && (
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(address)}
                className="inline-flex items-center gap-1 rounded-md border border-gray/10 px-2 py-1 text-[11px] text-gray transition-colors hover:text-foreground"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            )}
          </div>

          <div className="mt-3 break-all font-mono text-xs text-foreground/85">
            {address ?? "No Sui signer connected"}
          </div>

          <div className="mt-4 grid gap-2 text-xs">
            {zkLoginReadiness.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-3">
                <span className="text-gray">{item.label}</span>
                <span className={cn("font-semibold", item.ok ? "text-sui" : "text-warning")}>
                  {item.ok ? "configured" : "missing"}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-t border-gray/10 pt-2">
              <span className="text-gray">UTXOpia PTB builder</span>
              <span className="font-semibold text-sui">
                {ptbBytes ? `${ptbBytes} bytes` : "ready"}
              </span>
            </div>
          </div>

          {session && (
            <div className="mt-4 rounded-md border border-gray/10 bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                Ephemeral session
                <ArrowRight className="h-3 w-3 text-gray" />
                epoch {session.maxEpoch}
              </div>
              <div className="mt-2 break-all font-mono text-[11px] text-gray">
                {session.ephemeralPublicKey}
              </div>
            </div>
          )}

          {message && (
            <p className={cn("mt-4 text-xs leading-5", status === "error" ? "text-error" : "text-gray")}>
              {message}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 rounded-md border border-sui/15 bg-sui/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">UTXOpia key derivation</h3>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-gray">
              Dev path using a random 65-byte signature. zkLogin can later pass its deterministic signature bytes into the same derivation.
            </p>
          </div>
          <button
            type="button"
            onClick={generateRandomUtxopiaKeys}
            disabled={authPreviewStatus === "loading"}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-sui/20 bg-background/70 px-3 py-2 text-xs font-semibold text-sui transition-colors hover:border-sui/40 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", authPreviewStatus === "loading" && "animate-spin")} />
            Random signature
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <KeyPreviewRow label="Auth signature" value={authPreview?.signatureHex} />
          <KeyPreviewRow label="Root" value={authPreview?.rootHex} />
          <KeyPreviewRow label="UTXO address" value={authPreview?.encodedStealthAddress} />
          <KeyPreviewRow label="Viewing pubkey" value={authPreview?.viewingPubKeyHex} />
          <KeyPreviewRow label="Regtest BTC preview" value={authPreview?.directDeposit.btcAddress} />
          <KeyPreviewRow label="OP_RETURN" value={authPreview?.directDeposit.opReturnHex} />
          <KeyPreviewRow label="Ephemeral pubkey" value={authPreview?.directDeposit.ephemeralPubHex} />
          <KeyPreviewRow label="NPK" value={authPreview?.directDeposit.npkHex} />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-gray">
          <span>Nullifier is derived from spending internally.</span>
          <span className="font-mono">{authPreview?.nullifierFingerprint ?? "not generated"}</span>
        </div>
      </div>
    </section>
  );
}

function KeyPreviewRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-gray/10 bg-background/45 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-gray">{label}</span>
        {value && (
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(value)}
            className="rounded p-1 text-gray transition-colors hover:text-foreground"
            aria-label={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="truncate font-mono text-xs text-foreground/85" title={value}>
        {value ?? "Generate to preview"}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  children,
  icon,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 rounded px-3 py-2 text-xs font-semibold transition-colors",
        active ? "bg-sui/10 text-sui" : "text-gray hover:bg-muted/30 hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Status({ state }: { state: "idle" | "loading" | "ready" | "error" }) {
  const ok = state === "ready";
  const error = state === "error";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
        ok && "border-sui/20 bg-sui/10 text-sui",
        error && "border-error/20 bg-error/10 text-error",
        !ok && !error && "border-gray/15 bg-muted/20 text-gray",
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
      {state}
    </span>
  );
}
