"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronRight, Droplets, PlusCircle, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { isChainHybridNetwork } from "@/lib/chain-registry";
import type { NetworkId } from "@/lib/network-config";

interface VaultActionsProps {
  networkId: NetworkId;
  isViewOnly: boolean;
  depositCount: number;
}

export function VaultActions({
  networkId,
  isViewOnly,
  depositCount,
}: VaultActionsProps) {
  const actions = [
    { icon: <PlusCircle className="w-5 h-5" />, label: "Add funds", href: "/vault/deposit", color: "text-green-400" },
    ...(isChainHybridNetwork(networkId, "solana")
      ? [{ icon: <Droplets className="w-5 h-5" />, label: "Faucet", href: "/faucet", color: "text-warning" }]
      : []),
    { icon: <Send className="w-5 h-5" />, label: "Send", href: "/send", color: "text-purple-400" },
  ].filter((action) => !isViewOnly || action.label === "Send");

  return (
    <>
      <div className="flex items-center justify-center gap-5 sm:gap-8 mb-6">
        {actions.map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className="flex flex-col items-center gap-1.5 group cursor-pointer"
          >
            <motion.div
              className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center",
                "bg-muted/80 border border-gray/15",
                "group-hover:border-privacy/30 group-hover:bg-privacy/10",
                "transition-colors duration-200",
                action.color,
              )}
              whileHover={{ scale: 1.08, y: -2 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              {action.icon}
            </motion.div>
            <span className="text-[11px] text-gray group-hover:text-foreground transition-colors">
              {action.label}
            </span>
          </Link>
        ))}
      </div>

      {depositCount > 0 && (
        <div className="flex justify-center mb-5">
          <Link
            href="/vault/activity"
            className="flex items-center gap-1 text-[11px] text-gray/40 hover:text-gray/60 transition-colors cursor-pointer"
          >
            View activity <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </>
  );
}
