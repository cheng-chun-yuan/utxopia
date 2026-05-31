"use client";

import Link from "next/link";
import Image from "next/image";
import { motion } from "framer-motion";
import { useChainEnvironment } from "@/lib/chain-environment";
import { hrefWithChain } from "@/lib/network-config";

export function SiteFooter() {
  const { networkId, config } = useChainEnvironment();
  const chain = config.chain ?? "solana";
  const chainName = chain === "sui" ? "Sui" : "Solana";

  return (
    <footer className="w-full border-t border-gray/10 bg-background/80 backdrop-blur-lg py-12 px-6 relative overflow-hidden">
      {/* Subtle top gradient line */}
      <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-privacy/20 to-transparent" />

      <motion.div
        className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6"
        initial={{ opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
      >
        <Link href={hrefWithChain("/", networkId)} className="flex items-center gap-2 group">
          <div className="relative w-6 h-6 flex items-center justify-center transition-transform group-hover:scale-110">
            <Image
              src="/brand/logo-transparent-128.png"
              alt="UTXOpia"
              width={24}
              height={24}
              className="h-full w-full object-contain"
            />
          </div>
          <span className="text-sm font-medium tracking-tight text-foreground group-hover:text-privacy transition-colors">
            UTXOpia
          </span>
        </Link>

        <div className="text-caption text-gray">
          ZK Privacy for Every Token on {chainName}
        </div>

        <div className="text-caption text-gray/60">
          Privacy-preserving bridge infrastructure
        </div>
      </motion.div>
    </footer>
  );
}
