"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ExternalLink, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  detectNetwork,
  setNetwork,
  NETWORK_META,
  getNetworkConfig,
  type NetworkId,
  type NetworkMeta,
} from "@/lib/network-config";

// Re-render when localStorage flips in another tab.
function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/**
 * Network selector — flat radio-style rows, not fat cards. The active
 * network gets a filled privacy-green indicator dot; inactive rows show
 * a hairline ring. Description + caveats are kept behind a per-row
 * Details disclosure so the list scans like a contact list, not a wall
 * of cards.
 */
export function NetworkSelector() {
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
    // Hard reload — most singletons read network config at module load.
    setTimeout(() => window.location.reload(), 50);
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-gray/10 border-y border-gray/10">
        {NETWORK_META.filter((n) => n.enabled).map((meta) => (
          <NetworkRow
            key={meta.id}
            meta={meta}
            active={active === meta.id}
            pending={pending === meta.id}
            onSelect={() => handleSelect(meta.id)}
          />
        ))}
      </ul>

      {active && (
        <details className="text-[11px] text-gray group" >
          <summary className="list-none cursor-pointer inline-flex items-center gap-1 hover:text-foreground transition-colors">
            <ChevronDown className="w-3 h-3 transition-transform group-open:rotate-180" />
            Effective config
          </summary>
          <ConfigReadout networkId={active} />
        </details>
      )}
    </div>
  );
}

function NetworkRow({
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
    <li>
      <div
        className={cn(
          "group relative py-3 px-1 transition-colors",
          active ? "bg-privacy/[0.03]" : "hover:bg-muted/20",
          pending && "opacity-50",
        )}
      >
        <div className="flex items-start gap-3">
          {/* Radio indicator — filled privacy-green when active */}
          <button
            type="button"
            onClick={onSelect}
            disabled={pending}
            aria-pressed={active}
            aria-label={`Switch to ${meta.label}`}
            className={cn(
              "shrink-0 mt-1 h-3.5 w-3.5 rounded-full transition-all duration-200",
              "flex items-center justify-center",
              active
                ? "bg-privacy ring-2 ring-privacy/30 ring-offset-2 ring-offset-background"
                : "border border-gray/40 hover:border-foreground/60",
              pending ? "cursor-wait" : "cursor-pointer",
            )}
          />

          <div className="flex-1 min-w-0">
            {/* Click target spans the label area too */}
            <button
              type="button"
              onClick={onSelect}
              disabled={pending}
              className="block w-full text-left disabled:cursor-wait"
            >
              <div className="flex items-baseline gap-2 flex-wrap">
                <span
                  className={cn(
                    "text-sm transition-colors",
                    active
                      ? "text-foreground font-semibold"
                      : "text-foreground/85 font-medium group-hover:text-foreground",
                  )}
                >
                  {meta.label}
                </span>
                <span className="text-[11px] text-gray font-mono">
                  {meta.id}
                </span>
                {active && (
                  <span className="text-[9px] uppercase tracking-[0.15em] text-privacy font-semibold">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray mt-0.5 truncate">
                {meta.tagline}
              </p>
            </button>

            {(meta.description || meta.caveats.length > 0) && (
              <details
                className="mt-1.5 group/d"
                onClick={(e) => e.stopPropagation()}
              >
                <summary className="list-none cursor-pointer inline-flex items-center gap-1 text-[11px] text-gray/80 hover:text-foreground transition-colors">
                  <ChevronDown className="w-3 h-3 transition-transform group-open/d:rotate-180" />
                  Details
                </summary>
                <div className="mt-2 space-y-2 pl-1">
                  {meta.description && (
                    <p className="text-[12px] text-gray leading-relaxed max-w-[60ch]">
                      {meta.description}
                    </p>
                  )}
                  {meta.caveats.length > 0 && (
                    <ul className="space-y-1">
                      {meta.caveats.map((c, i) => (
                        <li
                          key={i}
                          className="text-[11px] text-gray flex items-start gap-1.5"
                        >
                          <AlertTriangle className="h-3 w-3 mt-0.5 text-warning shrink-0" />
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
    </li>
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
    <div className="mt-2 rounded-md bg-muted/20 overflow-hidden">
      {rows.map(([label, value, link], i) => (
        <div
          key={label}
          className={cn(
            "flex items-baseline gap-3 px-3 py-1.5",
            i > 0 && "border-t border-gray/5",
          )}
        >
          <span className="text-[10px] uppercase tracking-[0.12em] text-gray w-24 shrink-0">
            {label}
          </span>
          <span className="font-mono text-[11px] break-all text-foreground/85">
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="hover:text-privacy inline-flex items-center gap-1 transition-colors"
              >
                {value}
                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
              </a>
            ) : (
              value || (
                <span className="text-gray italic">unset</span>
              )
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
