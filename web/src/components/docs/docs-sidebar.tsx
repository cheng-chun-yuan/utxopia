"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Menu, X } from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  children?: { id: string; label: string }[];
}

export const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview" },
  {
    id: "protocol-flow",
    label: "Protocol Flow",
    children: [
      { id: "shield-tokens", label: "Shield Any Token" },
      { id: "spv-verification", label: "BTC SPV Verification" },
      { id: "shielded-commitment", label: "Commitment Creation" },
      { id: "joinsplit-transfer", label: "Private Transfer" },
      { id: "stealth-receive", label: "Stealth Receive" },
      { id: "unshield-withdraw", label: "Unshield / Withdraw" },
    ],
  },
  {
    id: "cryptography",
    label: "Cryptography",
    children: [
      { id: "commitment-scheme", label: "Commitment Scheme" },
      { id: "nullifier-generation", label: "Nullifier Generation" },
      { id: "master-public-key", label: "Master Public Key" },
      { id: "joinsplit-circuit", label: "JoinSplit Circuit" },
      { id: "eddsa-signatures", label: "EdDSA Signatures" },
      { id: "stealth-key-agreement", label: "Stealth Key Agreement" },
      { id: "sender-memo", label: "Sender Memo Channel" },
      { id: "proof-of-innocence", label: "Proof of Innocence" },
    ],
  },
  { id: "key-model", label: "Key Model" },
  {
    id: "disclosure",
    label: "Auditable Disclosure",
    children: [
      { id: "auditor-toolkit", label: "Auditor Toolkit" },
      { id: "sender-memo-channel", label: "Sender Memos" },
      { id: "proof-of-innocence-flow", label: "Proof of Innocence" },
      { id: "selective-disclosure-proofs", label: "Selective Disclosure" },
      { id: "compliance-toggle", label: "Compliance Toggle" },
    ],
  },
  { id: "security", label: "Security & Compliance" },
];

function getAllSectionIds(): string[] {
  const ids: string[] = [];
  for (const item of NAV_ITEMS) {
    ids.push(item.id);
    if (item.children) {
      for (const child of item.children) {
        ids.push(child.id);
      }
    }
  }
  return ids;
}

export function useAllSectionIds() {
  return getAllSectionIds();
}

/* ── Shared nav list (used by both desktop sidebar and mobile drawer) ── */

interface NavListProps {
  activeSection: string;
  onNavigate: (id: string) => void;
  /** Whether to animate collapsible groups (desktop uses framer-motion, mobile uses plain toggle) */
  animated?: boolean;
}

function NavList({ activeSection, onNavigate, animated = true }: NavListProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const isActive = (id: string) => activeSection === id;
  const isParentActive = (item: NavItem) =>
    item.children?.some((c) => activeSection === c.id) ?? false;

  return (
    <nav className="space-y-1">
      {NAV_ITEMS.map((item) => (
        <div key={item.id}>
          {item.children ? (
            <>
              <button
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                }
                className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-[11px] font-mono uppercase tracking-[0.2em] transition-colors ${
                  isParentActive(item) || isActive(item.id)
                    ? "text-foreground"
                    : "text-gray/40 hover:text-gray-light"
                }`}
              >
                {item.label}
                <ChevronDown
                  className={`w-3 h-3 transition-transform ${
                    collapsed[item.id] ? "-rotate-90" : ""
                  }`}
                />
              </button>
              {animated ? (
                <AnimatePresence initial={false}>
                  {!collapsed[item.id] && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      {item.children.map((child) => (
                        <NavButton
                          key={child.id}
                          id={child.id}
                          label={child.label}
                          isActive={isActive(child.id)}
                          isChild
                          onNavigate={onNavigate}
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : (
                !collapsed[item.id] &&
                item.children.map((child) => (
                  <NavButton
                    key={child.id}
                    id={child.id}
                    label={child.label}
                    isActive={isActive(child.id)}
                    isChild
                    onNavigate={onNavigate}
                  />
                ))
              )}
            </>
          ) : (
            <NavButton
              id={item.id}
              label={item.label}
              isActive={isActive(item.id)}
              onNavigate={onNavigate}
            />
          )}
        </div>
      ))}
    </nav>
  );
}

function NavButton({
  id,
  label,
  isActive,
  isChild,
  onNavigate,
}: {
  id: string;
  label: string;
  isActive: boolean;
  isChild?: boolean;
  onNavigate: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onNavigate(id)}
      className={`w-full text-left ${
        isChild ? "pl-8 pr-3 py-1.5" : "px-3 py-2"
      } text-[13px] font-medium rounded-md transition-colors border-l-2 ${
        isActive
          ? "border-privacy text-foreground bg-privacy/5"
          : "border-transparent text-gray hover:text-foreground hover:bg-muted/30"
      }`}
    >
      {label}
    </button>
  );
}

/* ── Desktop sidebar ── */

interface DocsSidebarProps {
  activeSection: string;
}

export function DocsSidebar({ activeSection }: DocsSidebarProps) {
  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
      window.history.replaceState(null, "", `#${id}`);
    }
  }, []);

  return <NavList activeSection={activeSection} onNavigate={handleClick} animated />;
}

/* ── Mobile sidebar bar + drawer ── */

interface MobileSidebarProps {
  activeSection: string;
}

export function MobileSidebarBar({ activeSection }: MobileSidebarProps) {
  const [open, setOpen] = useState(false);

  const activeLabel = (() => {
    for (const item of NAV_ITEMS) {
      if (item.id === activeSection) return item.label;
      if (item.children) {
        const child = item.children.find((c) => c.id === activeSection);
        if (child) return child.label;
      }
    }
    return "Overview";
  })();

  const handleClick = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
      window.history.replaceState(null, "", `#${id}`);
    }
    setOpen(false);
  };

  return (
    <>
      {/* Mobile menu button — aligned with nav pill */}
      {!open && (
        <div className="lg:hidden fixed top-[18px] left-4 z-50">
          <button
            onClick={() => setOpen(true)}
            className="p-2 rounded-lg border border-gray/10 bg-background/80 backdrop-blur-md hover:bg-muted/30 transition-colors shadow-sm"
          >
            <Menu className="w-4 h-4 text-gray" />
          </button>
        </div>
      )}

      {/* Drawer overlay + panel */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm lg:hidden"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed top-0 left-0 bottom-0 z-[60] w-[280px] max-w-[85vw] bg-background border-r border-gray/10 overflow-y-auto lg:hidden"
            >
              <div className="flex items-center justify-between px-4 py-4 border-b border-gray/10">
                <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-gray/40">
                  Documentation
                </span>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1 rounded-md hover:bg-muted/30 transition-colors"
                >
                  <X className="w-4 h-4 text-gray" />
                </button>
              </div>
              <div className="p-4">
                <NavList
                  activeSection={activeSection}
                  onNavigate={handleClick}
                  animated={false}
                />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
