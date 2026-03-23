"use client";

import { motion } from "framer-motion";
import { ExternalLink } from "lucide-react";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";

function AnimatedCheckmark() {
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-5 h-5"
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: [0, 1.2, 1], opacity: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-success"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />
      <motion.path
        d="M8 12.5l2.5 2.5 5.5-5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-success"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, delay: 0.3, ease: "easeOut" }}
      />
    </motion.svg>
  );
}

interface SuccessCardProps {
  title?: string;
  message?: string;
  txSignature?: string;
}

/**
 * Standardized success display card used across all flows.
 */
export function SuccessCard({
  title = "Success",
  message,
  txSignature,
}: SuccessCardProps) {
  const explorerUrl = txSignature ? getSolanaExplorerTxUrl(txSignature) : null;

  return (
    <motion.div
      className="space-y-3"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="flex items-center gap-3 p-3 bg-success/10 border border-success/20 rounded-[12px]"
        initial={{ boxShadow: "0 0 0 rgba(74, 222, 128, 0)" }}
        animate={{ boxShadow: ["0 0 20px rgba(74, 222, 128, 0.15)", "0 0 0 rgba(74, 222, 128, 0)"] }}
        transition={{ duration: 1.2, delay: 0.3 }}
      >
        <AnimatedCheckmark />
        <span className="text-body2 text-success">{title}</span>
      </motion.div>

      {message && (
        <motion.p
          className="text-body2 text-gray-light"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          {message}
        </motion.p>
      )}

      {explorerUrl && (
        <motion.div
          className="p-3 bg-muted border border-gray/15 rounded-[12px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          <p className="text-caption text-gray mb-1">Transaction</p>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caption font-mono text-privacy hover:underline break-all flex items-center gap-1"
          >
            {txSignature!.slice(0, 20)}...{txSignature!.slice(-20)}
            <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        </motion.div>
      )}
    </motion.div>
  );
}
