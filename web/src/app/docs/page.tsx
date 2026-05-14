"use client";

/**
 * DocsPage — technical documentation for the UTXOpia protocol.
 *
 * Sections:
 * - Overview: comparison table (traditional bridges vs UTXOpia)
 * - Protocol Flow: 6-step journey with FlowDiagram visualization
 * - Cryptography: commitments, nullifiers, MPK, JoinSplit, EdDSA, DKSAP,
 *   sender memo, Proof of Innocence
 * - Key Model: dual-key — spending (Baby Jubjub) + viewing (Ed25519);
 *   nullifier secret is derived from the spending key
 * - Auditable Disclosure: Phase 1–4 compliance layers with deployment status
 *   (auditor toolkit, sender memos, PoI, selective disclosure)
 * - Security & Compliance: policy gate, custody, SPV, double-spend, audit trail
 */

import Link from "next/link";
import { type LucideIcon } from "lucide-react";
import {
  Shield,
  Lock,
  Bitcoin,
  ArrowRight,
  ShieldCheck,
  TreePine,
  Layers,
  KeyRound,
  Eye,
  Network,
  GitBranch,
  ChevronRight,
  AlertTriangle,
  FileCheck,
  Send,
  ListChecks,
  ScrollText,
} from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { DocsSection } from "@/components/docs/docs-section";
import { FlowDiagram } from "@/components/docs/flow-diagram";
import {
  DocsSidebar,
  MobileSidebarBar,
  useAllSectionIds,
} from "@/components/docs/docs-sidebar";
import { useActiveSection } from "@/hooks/use-active-section";

/* ── Simple card wrapper ── */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-gray/10 bg-muted/10 p-5 sm:p-6 ${className}`}>
      {children}
    </div>
  );
}

/* ── Section heading ── */

function SectionHeading({ label, title, subtitle }: { label: string; title: React.ReactNode; subtitle?: string }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-px w-8 bg-gray/20" />
        <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-gray/50">
          {label}
        </span>
      </div>
      <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mb-3">
        {title}
      </h2>
      {subtitle && (
        <p className="text-gray text-sm max-w-2xl font-light leading-relaxed">
          {subtitle}
        </p>
      )}
    </div>
  );
}

/* ── Step card ── */

interface StepCardProps {
  num: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  detail: string;
}

function StepCard({ num, icon: Icon, title, desc, detail }: StepCardProps) {
  return (
    <Card>
      <div className="flex flex-col">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs font-mono text-gray/40">{num}</span>
          <div className="p-2 rounded-lg border border-gray/10 bg-background/50">
            <Icon className="w-4 h-4 text-gray-light" />
          </div>
          <h3 className="text-sm sm:text-base font-semibold text-foreground">{title}</h3>
        </div>
        <p className="text-xs sm:text-sm text-gray font-light leading-relaxed mb-3">
          {desc}
        </p>
        <div className="pt-2 border-t border-gray/5">
          <span className="text-[10px] font-mono text-gray/30">{detail}</span>
        </div>
      </div>
    </Card>
  );
}

/* ── Crypto card ── */

function CryptoCard({ title, formula, desc }: { title: string; formula: string; desc: string }) {
  return (
    <Card>
      <h3 className="text-sm sm:text-base font-semibold text-foreground mb-2">{title}</h3>
      <code className="inline-block text-[10px] sm:text-xs font-mono bg-background/50 border border-gray/10 px-2 sm:px-3 py-1.5 rounded-lg text-gray-light mb-3 self-start break-all">
        {formula}
      </code>
      <p className="text-xs sm:text-sm text-gray font-light leading-relaxed">{desc}</p>
    </Card>
  );
}

/* ── Disclosure card ── */

function DisclosureCard({ icon: Icon, title, status, desc, detail }: DisclosureItem) {
  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg border border-gray/10 bg-background/50">
            <Icon className="w-4 h-4 text-gray-light" />
          </div>
          <h3 className="text-sm sm:text-base font-semibold text-foreground">{title}</h3>
        </div>
        <span
          className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wider ${STATUS_STYLE[status]}`}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>
      <p className="text-xs sm:text-sm text-gray font-light leading-relaxed mb-3">{desc}</p>
      <div className="pt-2 border-t border-gray/5">
        <span className="text-[10px] font-mono text-gray/30 break-all">{detail}</span>
      </div>
    </Card>
  );
}

/* ── Security card ── */

function SecurityCard({ icon: Icon, title, desc }: { icon: LucideIcon; title: string; desc: string }) {
  return (
    <Card className="h-full">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-lg border border-gray/10 bg-background/50">
          <Icon className="w-4 h-4 text-gray-light" />
        </div>
        <h3 className="text-sm sm:text-base font-semibold text-foreground">{title}</h3>
      </div>
      <p className="text-xs sm:text-sm text-gray font-light leading-relaxed">{desc}</p>
    </Card>
  );
}

/* ── Key card ── */

function KeyCard({ icon: Icon, title, desc, features }: { icon: LucideIcon; title: string; desc: string; features: string[] }) {
  return (
    <Card className="h-full">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 rounded-lg border border-gray/10 bg-background/50">
          <Icon className="w-5 h-5 text-gray-light" />
        </div>
        <h3 className="text-base sm:text-lg font-semibold text-foreground">{title}</h3>
      </div>
      <p className="text-xs sm:text-sm text-gray font-light leading-relaxed mb-4">{desc}</p>
      <div className="space-y-2 mt-auto">
        {features.map((f) => (
          <div key={f} className="flex items-center gap-2 text-[10px] sm:text-[11px] font-mono text-gray/50">
            <span className="w-1.5 h-1.5 rounded-full bg-gray/30 shrink-0" />
            {f}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Comparison table ── */

const COMPARISON_ROWS = [
  { label: "Tokens", traditional: "Single asset (wBTC)", privateBtc: "Multi-token (BTC, SOL, USDC, USDT)" },
  { label: "Balances", traditional: "Visible on-chain", privateBtc: "Hidden as commitments" },
  { label: "Transfers", traditional: "Traceable amounts", privateBtc: "ZK-proven, zero knowledge" },
  { label: "Addresses", traditional: "Linkable & reusable", privateBtc: "One-time stealth addresses" },
  { label: "Deposits", traditional: "Public token minting", privateBtc: "Shielded Merkle insertion" },
  { label: "Withdrawals", traditional: "Traceable burn + send", privateBtc: "Unlinkable via nullifiers" },
  { label: "Custody", traditional: "Multisig / MPC", privateBtc: "Ika dWallet · Solana-controlled" },
];

function ComparisonTable() {
  return (
    <Card>
      {/* Desktop header */}
      <div className="hidden sm:grid grid-cols-3 gap-4 pb-3 mb-2 border-b border-gray/10">
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/40">Aspect</span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/40">Traditional Bridges</span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/50">UTXOpia</span>
      </div>
      {/* Mobile header */}
      <div className="sm:hidden pb-3 mb-2 border-b border-gray/10">
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/40">Comparison</span>
      </div>
      {COMPARISON_ROWS.map((row) => (
        <div key={row.label}>
          {/* Desktop row */}
          <div className="hidden sm:grid grid-cols-3 gap-4 py-3 border-b border-gray/5 last:border-0">
            <span className="text-sm text-gray-light font-medium">{row.label}</span>
            <span className="text-[12px] text-gray">{row.traditional}</span>
            <span className="text-[12px] text-foreground/70">{row.privateBtc}</span>
          </div>
          {/* Mobile row */}
          <div className="sm:hidden py-3 border-b border-gray/5 last:border-0 space-y-1.5">
            <span className="text-sm text-gray-light font-medium block">{row.label}</span>
            <div className="flex items-start gap-1.5 pl-2">
              <span className="text-[11px] text-gray">Traditional: {row.traditional}</span>
            </div>
            <div className="flex items-start gap-1.5 pl-2">
              <span className="text-[11px] text-foreground/70">Private: {row.privateBtc}</span>
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}

/* ── Data ── */

const PROTOCOL_STEPS = [
  {
    id: "shield-tokens", num: "01", icon: Shield, title: "Shield Any Token",
    desc: "Deposit BTC via Taproot, or shield SOL/USDC/USDT directly from your Solana wallet. Every token enters the same privacy pool — a shared Merkle tree where all commitments look identical regardless of token type or amount.",
    detail: "BTC: Taproot + SPV · SPL: Shield (disc=12)",
  },
  {
    id: "spv-verification", num: "02", icon: GitBranch, title: "BTC SPV Verification",
    desc: "Bitcoin deposits require a special step: the backend submits an SPV Merkle inclusion proof to the on-chain BTC light client. The Solana program independently validates the Bitcoin transaction was confirmed in a real block — trustless cross-chain verification without any oracle.",
    detail: "On-chain header chain · 6+ confirmations",
  },
  {
    id: "shielded-commitment", num: "03", icon: TreePine, title: "Commitment Creation",
    desc: "Your deposit becomes Poseidon(npk, tokenId, amount) — a cryptographic commitment. The token_id is derived from the SPL mint address: Poseidon(reduce(mint), 0). All tokens share the same depth-16 Merkle tree, making deposits indistinguishable.",
    detail: "Poseidon hash · Token-agnostic · 65,536 leaves",
  },
  {
    id: "joinsplit-transfer", num: "04", icon: Layers, title: "Private Transfer",
    desc: "Every transfer uses a Groth16 zero-knowledge proof that consumes N input notes and produces M output notes. The proof verifies balance conservation, token consistency, nullifier uniqueness, and Merkle membership — all without revealing any values. The same circuit works for BTC, SOL, USDC, or any shielded token.",
    detail: "Groth16 · 256 bytes · Token-agnostic circuit",
  },
  {
    id: "stealth-receive", num: "05", icon: Eye, title: "Stealth Receive",
    desc: "Recipients use one-time stealth addresses generated via the Dual-Key Stealth Address Protocol (EIP-5564) — X25519 ECDH against the recipient's viewing public key. Each deposit or transfer creates a fresh, unlinkable address. The recipient scans announcements with their viewing key to find their notes; senders can opt-in to a separate XChaCha20-Poly1305 memo so they retain their own outgoing history.",
    detail: "DKSAP · X25519 ECDH · Ed25519 viewing keys",
  },
  {
    id: "unshield-withdraw", num: "06", icon: Network, title: "Unshield or Withdraw",
    desc: "Exit the privacy pool in two ways: unshield SPL tokens back to your Solana wallet instantly, or withdraw BTC via an Ika dWallet whose authority is controlled by this Solana program (2PC-MPC, no off-chain signer committee). Both operations use a JoinSplit proof — the nullifier prevents double-spending without revealing which note you're spending.",
    detail: "SPL: instant · BTC: Ika dWallet (Solana-controlled)",
  },
];

const CRYPTO_ITEMS = [
  {
    id: "commitment-scheme", title: "Commitment Scheme",
    formula: "Poseidon(npk, token_id, amount)",
    desc: "Each note is a Poseidon hash of the note public key, token ID, and amount. The token_id = Poseidon(reduce(mint), 0) makes commitments token-specific — the same circuit verifies BTC, SOL, USDC, or any token. Only the owner knows the preimage.",
  },
  {
    id: "nullifier-generation", title: "Nullifier Generation",
    formula: "Poseidon(nullSecret(spendKey), leafIndex)",
    desc: "When spending a note, the nullifier is derived from a per-wallet null-secret (deterministically derived from your spending key) and the note's Merkle leaf index. You manage the spending key; the null-secret is generated for you. Publishing a nullifier prevents double-spending without revealing which note was consumed.",
  },
  {
    id: "master-public-key", title: "Master Public Key",
    formula: "MPK = Poseidon(spendPub, derivedNullSecret)",
    desc: "The MPK binds the Baby Jubjub spending public key to the wallet's derived null-secret. Per-note public keys come from NPK = Poseidon(MPK, random), giving each note a unique cryptographic identity. Both inputs ultimately trace back to a single spending key — you never manage the null-secret directly.",
  },
  {
    id: "joinsplit-circuit", title: "JoinSplit Circuit",
    formula: "JoinSplit(N, M, depth=16)",
    desc: "A single parameterized circom template handles all transfer types. Inputs: N note nullifiers + Merkle proofs. Outputs: M new commitments. The circuit verifies balance (Σin = Σout), nullifier validity, Merkle membership, and EdDSA-Poseidon signatures — all in one Groth16 proof. Each variant (1×1, 1×2, 2×1, 2×2, etc.) is a separate Groth16 setup; N + M ≤ 14.",
  },
  {
    id: "eddsa-signatures", title: "EdDSA-Poseidon Signatures",
    formula: "Sign(spendingKey, message)",
    desc: "Transaction authorization uses EdDSA over the Poseidon hash function on the Baby Jubjub curve. The message includes the Merkle root, bound parameters hash, all nullifiers, and all output commitments — binding the proof to a specific state and preventing a relayer from re-targeting it.",
  },
  {
    id: "stealth-key-agreement", title: "Stealth Key Agreement (DKSAP)",
    formula: "sharedSecret = X25519(ephemeral, viewKey)",
    desc: "Following the Dual-Key Stealth Address Protocol (EIP-5564). Senders generate a random ephemeral keypair and compute a shared secret with the recipient's viewing public key — derived from your viewing key via Ed25519→X25519 conversion. The shared secret derives the one-time note public key. Only the recipient can scan announcements using their viewing private key to detect incoming notes; even repeat payments are unlinkable on-chain.",
  },
  {
    id: "sender-memo", title: "Sender Memo Channel",
    formula: "XChaCha20-Poly1305(ovk, plaintext, AAD = commitment || leafIdx)",
    desc: "An opt-in second event per output, encrypted under the sender's outgoing viewing key (ovk = SHA-256(viewKey ‖ \"utxopia.ovk.v1\")). Lets the sender (or an auditor holding ovk) later recover their own outgoing history — recipient-only encryption alone wouldn't allow this. AAD binds each memo to its tree leaf: any tamper or re-targeting attempt fails the Poly1305 tag cleanly.",
  },
  {
    id: "proof-of-innocence", title: "Proof of Innocence",
    formula: "Groth16 over depth-20 association-set Merkle tree",
    desc: "User submits attest_poi (disc 22) referencing one of their commitments + a Groth16 proof of inclusion in the current admin-curated association root. On-chain verification emits an attestation event downstream consumers (CEXes, regulators) can consume. The proof's public inputs include the commitment in clear — a small privacy trade for an honor-system attestation that's verifiable on-chain.",
  },
];

type DisclosureStatus = "shipped" | "in-progress";

const STATUS_STYLE: Record<DisclosureStatus, string> = {
  shipped: "text-success border-success/30 bg-success/5",
  "in-progress": "text-warning border-warning/30 bg-warning/5",
};

const STATUS_LABEL: Record<DisclosureStatus, string> = {
  shipped: "Live",
  "in-progress": "Wiring",
};

interface DisclosureItem {
  id: string;
  icon: LucideIcon;
  title: string;
  status: DisclosureStatus;
  desc: string;
  detail: string;
}

const DISCLOSURE_ITEMS: DisclosureItem[] = [
  {
    id: "auditor-toolkit",
    icon: ScrollText,
    title: "Auditor Toolkit (DelegatedViewKey)",
    status: "shipped",
    desc: "Issue a slot-scoped, encrypted viewing key for your accountant or auditor. They drop it into the in-browser audit page, decrypt client-side, and walk away with a CSV of IN/OUT records over a chosen slot range. PBKDF2 + AES-GCM at rest; each issuance is tagged with a delegation ID so you keep a record of who you handed which key to.",
    detail: "scripts/auditor/issue.ts · sdk/src/auditor.ts · /audit",
  },
  {
    id: "sender-memo-channel",
    icon: Send,
    title: "Outgoing Sender Memos",
    status: "shipped",
    desc: "Per-output XChaCha20-Poly1305 envelopes encrypted to the sender's outgoing viewing key. AAD = commitment || leafIndex prevents move-the-memo attacks. Rust transact (disc 13) emits per output when memos are attached; SDK helper buildSenderMemosForTransact composes them client-side; /api/relay forwards them opaquely (viewing keys never leave the client); auditor honors ViewPermissions.INCOMING_ONLY to suppress OUT records when the delegation forbids them.",
    detail: "sdk/src/sender-memo.ts · web/src/app/api/relay/route.ts · sdk/src/auditor.ts",
  },
  {
    id: "proof-of-innocence-flow",
    icon: FileCheck,
    title: "Proof of Innocence",
    status: "shipped",
    desc: "Two-instruction PoI pipeline lives on-chain: update_association_root (disc 21, admin-curated clean set) and attest_poi (disc 22, user-submitted Groth16 against the current depth-20 root). The chain emits an attestation event tagging a commitment as innocent; compliance-sensitive recipients (CEXes, regulators) consume it without trusting the user. Phase 3d (merged JoinSplit+PoI that hides the commitment) is a tracked follow-up.",
    detail: "contracts/utxopia/instructions/poi.rs · backend/src/poi_service · scripts/auditor/attest-poi.ts",
  },
  {
    id: "selective-disclosure-proofs",
    icon: ListChecks,
    title: "Selective Disclosure Proofs",
    status: "shipped",
    desc: "Prove statements about your shielded holdings without revealing values: ownership-with-threshold (you control commitment X for at least amount Y of token T) and range-sum (sum across N notes ≤ ceiling). Circuits compiled, prover wired into the SDK, CLIs ship in scripts/auditor/. Today the range-sum circuit is fixed at N=8; N=4 and N=16 companion variants are tracked follow-ups.",
    detail: "circuits/build/ownership · scripts/auditor/prove-ownership.ts · scripts/auditor/prove-range-sum.ts",
  },
];

const SECURITY_ITEMS = [
  { icon: ShieldCheck, title: "On-Chain Policy Gate", desc: "Signing policy lives in the Solana program itself: amount limits, fee bounds, paused state, and destination whitelist are checked on-chain before the program issues the Ika `approve_message` CPI. A compromised backend cannot drain funds by submitting forged sighashes." },
  { icon: Network, title: "Ika dWallet Custody", desc: "BTC is held by an Ika dWallet whose authority is a PDA derived from this Solana program (`[\"__ika_cpi_authority\"]`). 2PC-MPC means the Ika network and our program must both participate in every signature — no single key, no off-chain signer committee. Pre-alpha runs a single mock signer; real distributed MPC ships at Ika mainnet." },
  { icon: GitBranch, title: "Trustless Verification", desc: "Bitcoin deposits are verified on-chain via SPV proofs against a light client tracking BTC block headers. The Solana program validates Merkle inclusion directly — no oracle or trusted third party." },
  { icon: Lock, title: "Double-Spend Prevention", desc: "Each note can only be spent once. Publishing a nullifier (derived from spending key + leaf index) marks the note as consumed. The on-chain program rejects duplicate nullifiers permanently." },
  { icon: AlertTriangle, title: "Auditable CPI Trail", desc: "Every redemption emits an `approve_message` CPI on-chain, with the sighash, dWallet ID, and signature scheme recorded as inner instructions in the Solana transaction. The full signing history is reconstructable from RPC alone — no separate audit log to operate." },
];

/* ── Page ── */

export default function DocsPage() {
  const sectionIds = useAllSectionIds();
  const activeSection = useActiveSection(sectionIds);

  return (
    <main className="min-h-screen bg-background">
      <SiteHeader />

      <MobileSidebarBar activeSection={activeSection} />

      <div className="relative z-10 flex">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-[260px] shrink-0">
          <div className="sticky top-[80px] h-[calc(100vh-80px)] overflow-y-auto border-r border-gray/10 px-4 py-8">
            <div className="mb-6">
              <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-gray/40">
                Documentation
              </span>
            </div>
            <DocsSidebar activeSection={activeSection} />
          </div>
        </aside>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 xl:px-12">

            {/* ── Hero ── */}
            {/* Top padding clears the fixed `top-4` nav pill (~64px tall). */}
            <section className="pt-24 sm:pt-28 lg:pt-32 pb-8 sm:pb-10">
              <div className="space-y-3 sm:space-y-4">
                <div className="flex">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray/15 bg-muted/20">
                    <Shield className="w-3.5 h-3.5 text-gray-light" />
                    <span className="text-[9px] sm:text-[10px] font-medium uppercase tracking-wider text-gray">
                      Privacy Documentation
                    </span>
                  </div>
                </div>
                <h1 className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight text-foreground">
                  How Privacy Works
                </h1>
                <p className="text-sm sm:text-base text-gray font-light max-w-2xl leading-relaxed">
                  A deep dive into the cryptography, architecture, and security model
                  that makes UTXOpia a universal shielded pool for BTC, SOL, USDC, and any token on Solana.
                </p>
              </div>
            </section>

            {/* ── Overview ── */}
            <DocsSection id="overview" className="pb-12 sm:pb-16">
              <SectionHeading
                label="The Problem"
                title="Why Tokens Need Privacy"
                subtitle="Every blockchain transaction is permanently public. Whether you're using BTC, SOL, or USDC — your balances, transfers, and trading patterns are visible to anyone. UTXOpia shields all your tokens in a single privacy pool."
              />
              <ComparisonTable />
            </DocsSection>

            {/* ── Protocol Flow ── */}
            <DocsSection id="protocol-flow" className="py-12 sm:py-16 border-t border-gray/10">
              <SectionHeading
                label="Protocol Flow"
                title="End-to-End Journey"
                subtitle="From shielding any token to private transfers to withdrawal — every step preserves your privacy across BTC, SOL, USDC, and more."
              />

              <FlowDiagram />

              <div className="mt-8 sm:mt-10 space-y-4">
                {PROTOCOL_STEPS.map((step) => (
                  <DocsSection key={step.id} id={step.id}>
                    <StepCard {...step} />
                  </DocsSection>
                ))}
              </div>
            </DocsSection>

            {/* ── Cryptography ── */}
            <DocsSection id="cryptography" className="py-12 sm:py-16 border-t border-gray/10">
              <SectionHeading
                label="Cryptography"
                title="Under the Hood"
                subtitle="The cryptographic primitives that make shielded transactions possible."
              />

              <div className="space-y-4">
                {CRYPTO_ITEMS.map((item) => (
                  <DocsSection key={item.id} id={item.id}>
                    <CryptoCard {...item} />
                  </DocsSection>
                ))}
              </div>
            </DocsSection>

            {/* ── Key Model ── */}
            <DocsSection id="key-model" className="py-12 sm:py-16 border-t border-gray/10">
              <SectionHeading
                label="Key Architecture"
                title="Dual-Key Model"
                subtitle="Two keys give you full control: one to spend, one to observe. The nullifier secret used during proving is derived automatically from your spending key — you never see it, copy it, or back it up separately."
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <KeyCard
                  icon={KeyRound}
                  title="Spending Key"
                  desc="Baby Jubjub elliptic curve keypair. Signs all JoinSplit transactions using EdDSA-Poseidon. The nullifier secret used inside the circuit is deterministically derived from this key, so a single 32-byte seed is enough to back up the entire wallet."
                  features={[
                    "Signs transactions (EdDSA-Poseidon)",
                    "Derives the nullifier secret",
                    "Generates the Master Public Key (MPK)",
                  ]}
                />
                <KeyCard
                  icon={Eye}
                  title="Viewing Key"
                  desc="Ed25519 keypair used exclusively for scanning stealth announcements. Detects incoming notes by matching the note public key (NPK). Derives the outgoing-viewing key (ovk) used for sender-memo decryption, so a single export key recovers both incoming and outgoing history. Share with auditors or compliance officers — they can read your transaction history but never spend your funds."
                  features={[
                    "Scans stealth announcements (incoming)",
                    "Derives ovk for sender-memo (outgoing)",
                    "Shareable for selective disclosure",
                  ]}
                />
              </div>
            </DocsSection>

            {/* ── Auditable Disclosure ── */}
            <DocsSection id="disclosure" className="py-12 sm:py-16 border-t border-gray/10">
              <SectionHeading
                label="Auditable Disclosure"
                title="Privacy with Receipts"
                subtitle="UTXOpia isn't an unaccountable mixer. Compliance tooling is built into the protocol — across four layers — so users can prove what they need to prove without surrendering custody. Each layer has its own deployment status."
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {DISCLOSURE_ITEMS.map((item) => (
                  <DocsSection key={item.id} id={item.id}>
                    <DisclosureCard {...item} />
                  </DocsSection>
                ))}
              </div>
            </DocsSection>

            {/* ── Security & Compliance ── */}
            <DocsSection id="security" className="py-12 sm:py-16 border-t border-gray/10">
              <SectionHeading
                label="Security"
                title="Security & Compliance"
                subtitle="Privacy doesn't mean unaccountable. Multiple layers of security and compliance are built into the protocol."
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {SECURITY_ITEMS.map((item) => (
                  <SecurityCard key={item.title} {...item} />
                ))}
              </div>
            </DocsSection>

            {/* ── CTA ── */}
            <section className="border-t border-gray/10 py-16 sm:py-20">
              <div className="max-w-3xl mx-auto text-center">
                <h2 className="text-xl sm:text-2xl md:text-3xl font-semibold tracking-tight text-foreground mb-4">
                  Ready to Go Private?
                </h2>
                <p className="text-gray text-xs sm:text-sm font-light mb-6 sm:mb-8 max-w-lg mx-auto leading-relaxed">
                  Shield BTC, SOL, USDC, or USDT. Transfer privately. Withdraw anonymously.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
                  <Link
                    href="/vault"
                    className="btn-privacy btn-pill inline-flex items-center gap-2 px-5 sm:px-7 py-2.5 text-sm sm:text-base transition-shadow"
                  >
                    <Shield className="w-4 h-4 sm:w-5 sm:h-5" />
                    Launch App
                    <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
                  </Link>
                  <Link
                    href="/explorer"
                    className="btn-tertiary btn-pill inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 text-sm border border-gray/10 hover:bg-muted/50 hover:border-gray/20 transition-all"
                  >
                    View Explorer
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <SiteFooter />
    </main>
  );
}
