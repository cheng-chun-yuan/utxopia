"use client";

import Link from "next/link";
import { Shield } from "lucide-react";
import { motion } from "framer-motion";

export function SiteFooter() {
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
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-6 h-6 flex items-center justify-center rounded-full bg-gradient-to-br from-privacy/20 to-privacy/30 group-hover:scale-110 transition-transform">
            <Shield className="w-3 h-3 text-privacy" />
          </div>
          <span className="text-sm font-medium tracking-tight text-foreground group-hover:text-privacy transition-colors">
            Privacy Coin
          </span>
        </Link>

        <div className="flex items-center gap-2 text-caption text-gray">
          <Shield className="w-3.5 h-3.5 text-privacy" />
          <span>ZK Privacy for Every Token on Solana</span>
        </div>

        <a href="https://zeusnetwork.xyz/" target="_blank" rel="noopener noreferrer" className="text-caption text-gray/60 hover:text-gray-light transition-all hover:-translate-y-0.5 flex items-center gap-1.5">
          Powered by <img src="/zeus_network.svg" alt="Zeus Network" className="w-4 h-4" />Zeus Network
        </a>
      </motion.div>
    </footer>
  );
}
