"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, AlertTriangle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/ui/info-tip";
import {
  detectNetwork,
  setNetwork,
  NETWORK_META,
  getNetworkConfig,
  type NetworkId,
  type NetworkMeta,
} from "@/lib/network-config";

// Subscription helper: re-render the picker when localStorage changes in
// another tab. The detect call happens on every render but is cheap.
function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export function NetworkSelector() {
  // useSyncExternalStore avoids the lint-flagged setState-in-useEffect
  // pattern while staying SSR-safe (server snapshot returns a fixed default).
  const active = useSyncExternalStore<NetworkId>(
    subscribe,
    () => detectNetwork(),
    () => "devnet",
  );
  const [pending, setPending] = useState<NetworkId | null>(null);

  function handleSelect(id: NetworkId) {
    if (id === active) return;
    setPending(id);
    setNetwork(id);
    // Hard reload — many singletons read network config at module load.
    setTimeout(() => window.location.reload(), 50);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Network</h3>
        <InfoTip label="About Network">
          Which UTXOpia stack the app talks to. Stored per-browser; reloads
          on switch.
        </InfoTip>
      </div>

      <div className="space-y-2.5">
        {NETWORK_META.filter((n) => n.enabled).map((meta) => (
          <NetworkCard
            key={meta.id}
            meta={meta}
            active={active === meta.id}
            pending={pending === meta.id}
            onSelect={() => handleSelect(meta.id)}
          />
        ))}
      </div>

      {active && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show effective config
          </summary>
          <ConfigReadout networkId={active} />
        </details>
      )}
    </div>
  );
}

function NetworkCard({
  meta,
  active,
  pending,
  onSelect,
}: {
  meta: NetworkMeta;
  active: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={pending}
      className={cn(
        "w-full text-left rounded-xl border p-4 transition-all",
        active
          ? "border-privacy/40 bg-privacy/5"
          : "border-gray/15 bg-muted/20 hover:border-privacy/30 hover:bg-privacy/[0.03]",
        pending ? "opacity-50 cursor-wait" : "cursor-pointer",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 h-5 w-5 rounded-full border flex items-center justify-center shrink-0",
            active
              ? "border-privacy bg-privacy text-background"
              : "border-gray/30",
          )}
        >
          {active && <Check className="h-3 w-3" strokeWidth={3} />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{meta.label}</span>
            <span className="text-[11px] text-muted-foreground font-mono">
              {meta.id}
            </span>
            {active && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-privacy/15 text-privacy font-semibold">
                Active
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {meta.tagline}
          </p>

          {(meta.description || meta.caveats.length > 0) && (
            <details
              className="mt-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <summary className="list-none cursor-pointer inline-block text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                Details
              </summary>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {meta.description}
              </p>
              {meta.caveats.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {meta.caveats.map((c, i) => (
                    <li
                      key={i}
                      className="text-[11px] text-muted-foreground flex items-start gap-1.5"
                    >
                      <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-500 shrink-0" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      </div>
    </button>
  );
}

function ConfigReadout({ networkId }: { networkId: NetworkId }) {
  const cfg = useMemo(() => {
    try {
      return getNetworkConfig(networkId);
    } catch {
      return null;
    }
  }, [networkId]);

  if (!cfg) return null;

  const rows: Array<[string, string, string?]> = [
    ["Solana RPC", cfg.solana.rpcUrl, cfg.solana.rpcUrl],
    ["Program", cfg.solana.utxopiaProgramId],
    ["zkBTC mint", cfg.tokens.zkbtcMint],
    ["BTC pool", cfg.bitcoin.poolAddress],
    ["BTC network", cfg.bitcoin.network],
    ["Backend", cfg.backend.url, cfg.backend.url],
    ["BTC explorer", cfg.bitcoin.explorerUrl, cfg.bitcoin.explorerUrl],
  ];

  return (
    <div className="mt-2 rounded-lg border border-gray/10 bg-muted/10 overflow-hidden">
      {rows.map(([label, value, link], i) => (
        <div
          key={label}
          className={cn(
            "flex items-baseline gap-3 px-3 py-1.5",
            i > 0 && "border-t border-gray/5",
          )}
        >
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-24 shrink-0">
            {label}
          </span>
          <span className="font-mono text-[11px] break-all">
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="hover:text-privacy inline-flex items-center gap-1"
              >
                {value}
                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
              </a>
            ) : (
              value || (
                <span className="text-muted-foreground italic">unset</span>
              )
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
