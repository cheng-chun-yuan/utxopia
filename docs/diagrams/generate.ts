import { writeFileSync } from "fs";
import { join } from "path";

// ─── ID & seed helpers ───────────────────────────────────────────────
let _idx = 0;
const makeId = () =>
  Math.random().toString(36).slice(2, 12) + (++_idx).toString(36);
const seed = () => Math.floor(Math.random() * 2_000_000_000);
const index = () => `a${_idx}`;

// ─── Base element ────────────────────────────────────────────────────
interface Opts {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  roundness?: { type: number } | null;
  groupIds?: string[];
  boundElements?: Array<{ id: string; type: string }> | null;
}

function base(
  type: string,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: Opts = {}
) {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: opts.strokeColor ?? "#1e1e1e",
    backgroundColor: opts.backgroundColor ?? "transparent",
    fillStyle: opts.fillStyle ?? "solid",
    strokeWidth: opts.strokeWidth ?? 2,
    strokeStyle: opts.strokeStyle ?? "solid",
    roughness: opts.roughness ?? 1,
    opacity: opts.opacity ?? 100,
    groupIds: opts.groupIds ?? [],
    frameId: null,
    index: index(),
    roundness: opts.roundness === undefined ? { type: 3 } : opts.roundness,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: opts.boundElements ?? null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

// ─── Element factories ───────────────────────────────────────────────
export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: Opts = {}
) {
  const id = makeId();
  return { ...base("rectangle", id, x, y, w, h, opts) };
}

export function ellipse(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: Opts = {}
) {
  const id = makeId();
  return {
    ...base("ellipse", id, x, y, w, h, { ...opts, roundness: null }),
  };
}

export function diamond(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: Opts = {}
) {
  const id = makeId();
  return {
    ...base("diamond", id, x, y, w, h, { ...opts, roundness: { type: 2 } }),
  };
}

interface TextOpts extends Opts {
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
}

export function text(
  x: number,
  y: number,
  content: string,
  opts: TextOpts = {}
) {
  const id = makeId();
  const fontSize = opts.fontSize ?? 20;
  const lines = content.split("\n");
  const maxLineLen = Math.max(...lines.map((l) => l.length));
  const w = maxLineLen * fontSize * 0.6;
  const h = lines.length * fontSize * 1.25;
  return {
    ...base("text", id, x, y, w, h, {
      ...opts,
      roundness: null,
      backgroundColor: "transparent",
    }),
    text: content,
    fontSize,
    fontFamily: opts.fontFamily ?? 2,
    textAlign: opts.textAlign ?? "center",
    verticalAlign: opts.verticalAlign ?? "middle",
    containerId: opts.containerId ?? null,
    originalText: content,
    autoResize: true,
    lineHeight: 1.25,
  };
}

interface ArrowOpts extends Opts {
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  startBinding?: any;
  endBinding?: any;
}

export function arrow(
  x: number,
  y: number,
  points: number[][],
  opts: ArrowOpts = {}
) {
  const id = makeId();
  const minX = Math.min(...points.map((p) => p[0]));
  const maxX = Math.max(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1]));
  const maxY = Math.max(...points.map((p) => p[1]));
  return {
    ...base("arrow", id, x, y, maxX - minX, maxY - minY, {
      ...opts,
      roundness: { type: 2 },
    }),
    points,
    startBinding: opts.startBinding ?? null,
    endBinding: opts.endBinding ?? null,
    startArrowhead: opts.startArrowhead ?? null,
    endArrowhead: opts.endArrowhead ?? "arrow",
    lastCommittedPoint: null,
  };
}

export function line(
  x: number,
  y: number,
  points: number[][],
  opts: Opts = {}
) {
  const id = makeId();
  const minX = Math.min(...points.map((p) => p[0]));
  const maxX = Math.max(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1]));
  const maxY = Math.max(...points.map((p) => p[1]));
  return {
    ...base("line", id, x, y, maxX - minX, maxY - minY, {
      ...opts,
      roundness: { type: 2 },
    }),
    points,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    lastCommittedPoint: null,
  };
}

// ─── Composite helpers ───────────────────────────────────────────────

/** Rectangle with centered label text */
export function labeledRect(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  opts: Opts & TextOpts = {}
) {
  const r = rect(x, y, w, h, opts);
  const fontSize = opts.fontSize ?? 16;
  const t = text(x + w / 2, y + h / 2, label, {
    fontSize,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: r.id,
    groupIds: opts.groupIds,
  });
  // Adjust text position to center
  t.x = x + (w - t.width) / 2;
  t.y = y + (h - t.height) / 2;
  r.boundElements = [{ id: t.id, type: "text" }];
  return [r, t];
}

/** Ellipse with centered label text */
export function labeledEllipse(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  opts: Opts & TextOpts = {}
) {
  const e = ellipse(x, y, w, h, opts);
  const fontSize = opts.fontSize ?? 14;
  const t = text(x + w / 2, y + h / 2, label, {
    fontSize,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: e.id,
    groupIds: opts.groupIds,
  });
  t.x = x + (w - t.width) / 2;
  t.y = y + (h - t.height) / 2;
  e.boundElements = [{ id: t.id, type: "text" }];
  return [e, t];
}

/** Diamond with centered label text */
export function labeledDiamond(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  opts: Opts & TextOpts = {}
) {
  const d = diamond(x, y, w, h, opts);
  const fontSize = opts.fontSize ?? 14;
  const t = text(x + w / 2, y + h / 2, label, {
    fontSize,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: d.id,
    groupIds: opts.groupIds,
  });
  t.x = x + (w - t.width) / 2;
  t.y = y + (h - t.height) / 2;
  d.boundElements = [{ id: t.id, type: "text" }];
  return [d, t];
}

/** Apply groupId to all elements */
export function group(elements: any[], groupId?: string) {
  const gid = groupId ?? makeId();
  for (const el of elements) {
    el.groupIds = [gid, ...(el.groupIds ?? [])];
  }
  return elements;
}

// ─── File output ─────────────────────────────────────────────────────
export function wrapFile(elements: any[]) {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: null,
    },
    files: {},
  };
}

export function writeExcalidraw(filename: string, elements: any[]) {
  const data = wrapFile(elements);
  const outPath = join(import.meta.dir, `${filename}.excalidraw`);
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Written: ${outPath} (${elements.length} elements)`);
}

// ─── Diagram generators ──────────────────────────────────────────────

function generateSystemOverview() {
  const els: any[] = [];

  // === BITCOIN LAYER ===
  els.push(
    ...group([
      rect(20, 20, 1360, 220, {
        backgroundColor: "#fff3e0",
        strokeColor: "#e65100",
        strokeWidth: 2,
      }),
    ])
  );
  els.push(
    text(40, 30, "BITCOIN LAYER", {
      fontSize: 24,
      strokeColor: "#e65100",
      textAlign: "left",
    })
  );

  // BTC boxes
  const btcY = 90;
  els.push(...labeledRect(60, btcY, 180, 60, "User Wallet", { backgroundColor: "#ffe0b2", fontSize: 16 }));
  els.push(...labeledRect(340, btcY, 200, 60, "Taproot Address", { backgroundColor: "#ffe0b2", fontSize: 16 }));
  els.push(...labeledRect(640, btcY, 200, 60, "Bitcoin Network", { backgroundColor: "#ffe0b2", fontSize: 16 }));
  els.push(...labeledRect(960, btcY, 200, 60, "Header Relayer", { backgroundColor: "#ffe0b2", fontSize: 16 }));

  // BTC arrows
  els.push(arrow(240, btcY + 30, [[0, 0], [100, 0]], { strokeColor: "#e65100" }));
  els.push(arrow(540, btcY + 30, [[0, 0], [100, 0]], { strokeColor: "#e65100" }));
  els.push(arrow(840, btcY + 30, [[0, 0], [120, 0]], { strokeColor: "#e65100" }));

  // Down arrow from Header Relayer
  els.push(arrow(1060, 170, [[0, 0], [0, 100]], { strokeColor: "#e65100" }));
  els.push(text(1075, 200, "headers", { fontSize: 14, strokeColor: "#e65100", textAlign: "left" }));

  // === SOLANA LAYER ===
  els.push(
    rect(20, 280, 1360, 280, {
      backgroundColor: "#f3e5f5",
      strokeColor: "#6a1b9a",
      strokeWidth: 2,
    })
  );
  els.push(
    text(40, 290, "SOLANA LAYER", {
      fontSize: 24,
      strokeColor: "#6a1b9a",
      textAlign: "left",
    })
  );

  // btc-light-client Program (separate on-chain program)
  els.push(
    ...labeledRect(60, 340, 280, 80, "btc-light-client Program\n(SPV Verification)\nS6rgPjCeBhk...", {
      backgroundColor: "#ce93d8",
      fontSize: 14,
    })
  );
  els.push(
    text(70, 425, "Separate on-chain program", {
      fontSize: 10,
      strokeColor: "#6a1b9a",
      textAlign: "left",
    })
  );

  // UTXOpia Program outer box
  els.push(
    rect(440, 330, 900, 210, {
      backgroundColor: "#e1bee7",
      strokeColor: "#6a1b9a",
      strokeWidth: 2,
    })
  );
  els.push(
    text(460, 335, "UTXOpia Program (Pinocchio)", {
      fontSize: 18,
      strokeColor: "#6a1b9a",
      textAlign: "left",
    })
  );

  // Inner boxes
  const innerY = 375;
  els.push(...labeledRect(460, innerY, 200, 55, "Commitment Tree\n(depth 16)", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(680, innerY, 180, 55, "Nullifier Registry", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(880, innerY, 200, 55, "Stealth Announcements\n(90B, type flag)", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(460, innerY + 70, 200, 55, "Name Registry\n(.zkey)", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(680, innerY + 70, 180, 55, "VK Registry", { backgroundColor: "#f3e5f5", fontSize: 13 }));

  // Arrow between BTC Light Client and UTXOpia
  els.push(arrow(340, 380, [[0, 0], [100, 0]], { strokeColor: "#6a1b9a", startArrowhead: "arrow" }));

  // Down arrow from Solana to Client
  els.push(arrow(700, 560, [[0, 0], [0, 70]], { strokeColor: "#6a1b9a" }));
  els.push(text(715, 580, "SDK calls", { fontSize: 14, strokeColor: "#6a1b9a", textAlign: "left" }));

  // === CLIENT LAYER ===
  els.push(
    rect(20, 620, 1360, 310, {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(40, 630, "CLIENT LAYER", {
      fontSize: 24,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );

  // SDK box
  els.push(
    ...labeledRect(400, 670, 600, 60, "@utxopia/sdk\n(Note Mgmt | Proofs | Stealth | Taproot)", {
      backgroundColor: "#90caf9",
      fontSize: 14,
    })
  );

  // Client boxes (simple)
  const clientY = 770;
  els.push(...labeledRect(60, clientY, 200, 55, "Web App\n(Next.js)", { backgroundColor: "#bbdefb", fontSize: 14 }));

  // Backend container (expanded)
  els.push(
    rect(290, clientY, 280, 100, {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(300, clientY + 5, "Backend (Rust)", {
      fontSize: 14,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  els.push(...labeledRect(300, clientY + 28, 80, 28, "Deposit\nTracker", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(388, clientY + 28, 80, 28, "Redemption\nService", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(476, clientY + 28, 80, 28, "Header\nRelayer (TS)", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));

  // FROST Server container (expanded)
  els.push(
    rect(600, clientY, 280, 100, {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(610, clientY + 5, "FROST Server", {
      fontSize: 14,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  els.push(...labeledRect(610, clientY + 28, 75, 28, "Policy\nEngine", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(693, clientY + 28, 75, 28, "Audit\nLog", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(776, clientY + 28, 75, 28, "Crypto", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(610, clientY + 64, 241, 28, "DKG + Signing (secp256k1-tr)", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));

  // Arrows from SDK to clients
  els.push(arrow(500, 730, [[0, 0], [-340, 40]], { strokeColor: "#1565c0" }));
  els.push(arrow(600, 730, [[0, 0], [-170, 40]], { strokeColor: "#1565c0" }));
  els.push(arrow(800, 730, [[0, 0], [-60, 40]], { strokeColor: "#1565c0" }));

  writeExcalidraw("system-overview", els);
}

function generateDepositWithdrawFlow() {
  const els: any[] = [];

  // Helper for step boxes in a swimlane
  function stepBoxes(
    steps: string[],
    startX: number,
    y: number,
    color: string,
    bgColor: string,
    stepW = 160,
    stepH = 50,
    gap = 20
  ) {
    const result: any[] = [];
    for (let i = 0; i < steps.length; i++) {
      const x = startX + i * (stepW + gap);
      result.push(
        ...labeledRect(x, y, stepW, stepH, steps[i], {
          backgroundColor: bgColor,
          strokeColor: color,
          fontSize: 12,
        })
      );
      if (i < steps.length - 1) {
        result.push(
          arrow(x + stepW, y + stepH / 2, [[0, 0], [gap, 0]], {
            strokeColor: color,
          })
        );
      }
    }
    return result;
  }

  // =====================================================================
  // SECTION 1: DEPOSIT FLOW (User → Bitcoin → Backend → Solana)
  // =====================================================================
  els.push(
    rect(10, 10, 1960, 680, {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      strokeWidth: 2,
    })
  );
  els.push(
    text(30, 20, "DEPOSIT FLOW — Full Lifecycle", {
      fontSize: 24,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );

  // --- Phase 1: User-side (key gen + BTC send) ---
  els.push(
    rect(30, 55, 900, 120, {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(45, 60, "Phase 1: User Creates Deposit", {
      fontSize: 14,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );
  const phase1Steps = [
    "Generate Keys\n(BJJ+Ed25519+Null)",
    "Derive Taproot\nAddress (npk-tweaked)",
    "Send BTC\n+ OP_RETURN",
  ];
  els.push(...stepBoxes(phase1Steps, 50, 85, "#2e7d32", "#a5d6a7", 200, 55, 30));
  // OP_RETURN annotation
  els.push(
    ...labeledRect(560, 148, 230, 22, "OP_RETURN: ephemeralPub(32) + npk(32)", {
      backgroundColor: "transparent",
      strokeColor: "#2e7d32",
      strokeStyle: "dashed",
      fontSize: 10,
    })
  );

  // --- Phase 2: Backend Detection + Sweep ---
  els.push(
    rect(30, 190, 1920, 190, {
      backgroundColor: "#c8e6c9",
      strokeColor: "#388e3c",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(45, 195, "Phase 2: Backend Detects Deposit and Sweeps to Pool Custody", {
      fontSize: 14,
      strokeColor: "#388e3c",
      textAlign: "left",
    })
  );

  // Backend state machine row
  const stateY = 225;
  const stateW = 120;
  const stateH = 40;
  const stateGap = 12;
  const states = [
    { label: "Pending", bg: "#e0e0e0" },
    { label: "Detected", bg: "#fff9c4" },
    { label: "Confirming", bg: "#fff9c4" },
    { label: "Confirmed", bg: "#c8e6c9" },
    { label: "Sweeping", bg: "#ffe0b2" },
    { label: "SweepConfirm", bg: "#ffe0b2" },
    { label: "Verifying", bg: "#bbdefb" },
    { label: "Ready", bg: "#c8e6c9" },
    { label: "Claimed", bg: "#a5d6a7" },
  ];
  for (let i = 0; i < states.length; i++) {
    const x = 50 + i * (stateW + stateGap);
    els.push(
      ...labeledRect(x, stateY, stateW, stateH, states[i].label, {
        backgroundColor: states[i].bg,
        strokeColor: "#555",
        fontSize: 11,
      })
    );
    if (i < states.length - 1) {
      els.push(
        arrow(x + stateW, stateY + stateH / 2, [[0, 0], [stateGap, 0]], {
          strokeColor: "#777",
        })
      );
    }
  }
  els.push(
    text(50, stateY + 48, "Backend Deposit State Machine", {
      fontSize: 11,
      strokeColor: "#666",
      textAlign: "left",
    })
  );

  // Sweep detail boxes
  const sweepY = 295;
  els.push(
    ...labeledRect(50, sweepY, 220, 55, "Backend Detects\nDeposit UTXO\n(watches taproot addr)", {
      backgroundColor: "#dcedc8",
      strokeColor: "#388e3c",
      fontSize: 11,
    })
  );
  els.push(arrow(270, sweepY + 27, [[0, 0], [30, 0]], { strokeColor: "#388e3c" }));
  els.push(
    ...labeledRect(300, sweepY, 220, 55, "Wait 1+ Confirm\non Deposit Tx", {
      backgroundColor: "#dcedc8",
      strokeColor: "#388e3c",
      fontSize: 12,
    })
  );
  els.push(arrow(520, sweepY + 27, [[0, 0], [30, 0]], { strokeColor: "#388e3c" }));
  els.push(
    ...labeledRect(550, sweepY, 250, 55, "FROST Sweep Tx\n(taproot addr → pool wallet)\n(no OP_RETURN)", {
      backgroundColor: "#ffe0b2",
      strokeColor: "#e65100",
      fontSize: 11,
    })
  );
  els.push(arrow(800, sweepY + 27, [[0, 0], [30, 0]], { strokeColor: "#e65100" }));
  els.push(
    ...labeledRect(830, sweepY, 220, 55, "Wait 2+ Confirm\non Sweep Tx", {
      backgroundColor: "#ffe0b2",
      strokeColor: "#e65100",
      fontSize: 12,
    })
  );
  els.push(arrow(1050, sweepY + 27, [[0, 0], [30, 0]], { strokeColor: "#e65100" }));
  els.push(
    ...labeledRect(1080, sweepY, 200, 55, "Header Relayer\nSyncs Sweep Block\nto Solana", {
      backgroundColor: "#ffe0b2",
      strokeColor: "#e65100",
      fontSize: 11,
    })
  );

  // --- Phase 3: SPV Verification of SWEEP TX on Solana ---
  els.push(
    rect(30, 400, 1920, 130, {
      backgroundColor: "#c8e6c9",
      strokeColor: "#1b5e20",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(45, 405, "Phase 3: SPV Verification via btc-light-client Program (complete_deposit instruction)", {
      fontSize: 14,
      strokeColor: "#1b5e20",
      textAlign: "left",
    })
  );

  const spvY = 435;
  els.push(
    ...labeledRect(50, spvY, 180, 55, "Upload Sweep Tx\nto ChadBuffer\n(non-witness data)", {
      backgroundColor: "#b2dfdb",
      strokeColor: "#00695c",
      fontSize: 11,
    })
  );
  els.push(arrow(230, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#00695c" }));
  els.push(
    ...labeledRect(250, spvY, 170, 55, "Verify txid\ndouble_sha256\n== sweep_txid", {
      backgroundColor: "#b2dfdb",
      strokeColor: "#00695c",
      fontSize: 11,
    })
  );
  els.push(arrow(420, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#00695c" }));
  els.push(
    ...labeledRect(440, spvY, 170, 55, "Merkle Proof\nvs Block Header\n(on-chain)", {
      backgroundColor: "#b2dfdb",
      strokeColor: "#00695c",
      fontSize: 11,
    })
  );
  els.push(arrow(610, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#00695c" }));
  els.push(
    ...labeledRect(630, spvY, 170, 55, "Check 2+\nConfirmations\n(btc-light-client program)", {
      backgroundColor: "#b2dfdb",
      strokeColor: "#00695c",
      fontSize: 11,
    })
  );
  els.push(arrow(800, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#00695c" }));
  els.push(
    ...labeledRect(820, spvY, 190, 55, "Compute Commitment\nPoseidon(npk, token,\namount) on-chain", {
      backgroundColor: "#b2dfdb",
      strokeColor: "#00695c",
      fontSize: 11,
    })
  );
  els.push(arrow(1010, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#00695c" }));
  els.push(
    ...labeledRect(1030, spvY, 170, 55, "Insert into\nMerkle Tree\n(depth 16)", {
      backgroundColor: "#a5d6a7",
      strokeColor: "#1b5e20",
      fontSize: 11,
    })
  );
  els.push(arrow(1200, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#1b5e20" }));
  els.push(
    ...labeledRect(1220, spvY, 170, 55, "Create Stealth\nAnnouncement PDA\n(90 bytes)", {
      backgroundColor: "#a5d6a7",
      strokeColor: "#1b5e20",
      fontSize: 11,
    })
  );
  els.push(arrow(1390, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#1b5e20" }));
  els.push(
    ...labeledRect(1410, spvY, 150, 55, "Mint zkBTC\nto Pool Vault\n(Token-2022)", {
      backgroundColor: "#a5d6a7",
      strokeColor: "#1b5e20",
      fontSize: 11,
    })
  );

  // SPV accounts annotation
  els.push(
    text(50, spvY + 65, "Accounts: pool_state | light_client | block_header | commitment_tree | deposit_record | chadbuffer | authority | system | zkbtc_mint | pool_vault | token-2022 | btc_light_client_program", {
      fontSize: 10,
      strokeColor: "#666",
      textAlign: "left",
    })
  );

  // --- Phase 4: Recipient Claims ---
  els.push(
    rect(30, 545, 1920, 130, {
      backgroundColor: "#c8e6c9",
      strokeColor: "#1b5e20",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(45, 550, "Phase 4: Recipient Scans and Claims via transact Instruction (JoinSplit 1x2)", {
      fontSize: 14,
      strokeColor: "#1b5e20",
      textAlign: "left",
    })
  );

  const claimY = 580;
  els.push(
    ...labeledRect(50, claimY, 200, 55, "Recipient Scans\nDeposit Records\n(viewing key + ECDH)", {
      backgroundColor: "#dcedc8",
      strokeColor: "#33691e",
      fontSize: 11,
    })
  );
  els.push(arrow(250, claimY + 27, [[0, 0], [30, 0]], { strokeColor: "#33691e" }));
  els.push(
    ...labeledRect(280, claimY, 200, 55, "Detect Own Deposit\nvia npk Matching\n(Ed25519 shared secret)", {
      backgroundColor: "#dcedc8",
      strokeColor: "#33691e",
      fontSize: 11,
    })
  );
  els.push(arrow(480, claimY + 27, [[0, 0], [30, 0]], { strokeColor: "#33691e" }));
  els.push(
    ...labeledRect(510, claimY, 200, 55, "Generate JoinSplit\n1x2 Claim Proof\n(Groth16 ~256 bytes)", {
      backgroundColor: "#c5e1a5",
      strokeColor: "#33691e",
      fontSize: 11,
    })
  );
  els.push(arrow(710, claimY + 27, [[0, 0], [30, 0]], { strokeColor: "#33691e" }));
  els.push(
    ...labeledRect(740, claimY, 200, 55, "Transact Instruction\n(1 input → 2 outputs)\nNullifier Published", {
      backgroundColor: "#c5e1a5",
      strokeColor: "#33691e",
      fontSize: 11,
    })
  );
  els.push(arrow(940, claimY + 27, [[0, 0], [30, 0]], { strokeColor: "#33691e" }));
  els.push(
    ...labeledRect(970, claimY, 200, 55, "New Commitments\nInserted in Tree\n(spendable notes)", {
      backgroundColor: "#a5d6a7",
      strokeColor: "#1b5e20",
      fontSize: 11,
    })
  );
  // Checkmark
  els.push(text(1200, claimY + 10, "\u2713", { fontSize: 32, strokeColor: "#1b5e20" }));

  // =====================================================================
  // SECTION 2: PRIVATE TRANSFER
  // =====================================================================
  els.push(
    rect(10, 710, 1960, 150, {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(30, 720, "PRIVATE TRANSFER — JoinSplit(N,M) Proof", {
      fontSize: 24,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  const transferSteps = [
    "Sender has\nCommitments",
    "Generate JoinSplit\nN×M Proof",
    "Transact\nInstruction",
    "Old Nullifiers\nPublished",
    "New Commitments\nInserted",
    "Stealth Data\n(in Announcement)",
  ];
  els.push(...stepBoxes(transferSteps, 50, 765, "#1565c0", "#bbdefb", 190, 55, 30));
  // Annotation
  els.push(
    ...labeledRect(330, 830, 200, 22, "Groth16 ~256 bytes (BN254)", {
      backgroundColor: "transparent",
      strokeColor: "#1565c0",
      strokeStyle: "dashed",
      fontSize: 10,
    })
  );
  els.push(
    ...labeledRect(780, 830, 260, 22, "EdDSA-Poseidon Signature Required", {
      backgroundColor: "transparent",
      strokeColor: "#1565c0",
      strokeStyle: "dashed",
      fontSize: 10,
    })
  );

  // =====================================================================
  // SECTION 3: WITHDRAWAL FLOW
  // =====================================================================
  els.push(
    rect(10, 880, 1960, 200, {
      backgroundColor: "#fce4ec",
      strokeColor: "#c62828",
      strokeWidth: 2,
    })
  );
  els.push(
    text(30, 890, "WITHDRAWAL FLOW — BTC Redemption via FROST", {
      fontSize: 24,
      strokeColor: "#c62828",
      textAlign: "left",
    })
  );
  const withdrawSteps = [
    "Request\nRedemption\n(ZK proof)",
    "Nullifier\nPublished\n(no double-spend)",
    "zkBTC Burned\nfrom Pool\n(Token-2022)",
    "FROST Server\n2-of-3 Signing\n(policy checked)",
    "BTC Transaction\nBroadcast\n(Schnorr BIP-340)",
    "Complete\nRedemption\n(relayer confirms)",
  ];
  els.push(...stepBoxes(withdrawSteps, 50, 935, "#c62828", "#ffcdd2", 200, 70, 30));
  // Annotations
  els.push(
    ...labeledRect(320, 1015, 280, 22, "Amount revealed ONLY at withdrawal", {
      backgroundColor: "transparent",
      strokeColor: "#c62828",
      strokeStyle: "dashed",
      fontSize: 10,
    })
  );
  els.push(
    ...labeledRect(820, 1015, 260, 22, "Each signer validates independently", {
      backgroundColor: "transparent",
      strokeColor: "#c62828",
      strokeStyle: "dashed",
      fontSize: 10,
    })
  );
  // Checkmark
  els.push(text(1450, 950, "\u2713", { fontSize: 32, strokeColor: "#c62828" }));

  // =====================================================================
  // SECTION 4: Data Flow Legend (right side)
  // =====================================================================
  els.push(
    rect(1580, 55, 370, 340, {
      backgroundColor: "#fafafa",
      strokeColor: "#555",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(1600, 62, "KEY DATA STRUCTURES", {
      fontSize: 16,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  const legendY = 92;
  const legendItems = [
    { label: "OP_RETURN (deposit)", desc: "ephemeralPub(32) + npk(32)", color: "#2e7d32" },
    { label: "Sweep Tx", desc: "single P2TR output (no OP_RETURN)", color: "#e65100" },
    { label: "Commitment", desc: "Poseidon(npk, token, amount)", color: "#00695c" },
    { label: "Nullifier", desc: "Poseidon(nullKey, leafIndex)", color: "#c62828" },
    { label: "NPK", desc: "Poseidon(MPK, random)", color: "#6a1b9a" },
    { label: "MPK", desc: "Poseidon(spendPub.x, .y, nullKey)", color: "#6a1b9a" },
    { label: "Stealth Announcement", desc: "90 bytes PDA ([\"stealth\", txid])", color: "#1565c0" },
    { label: "Block Header", desc: "PDA at btc-light-client (80-byte header)", color: "#e65100" },
    { label: "ChadBuffer", desc: "authority(32) + raw_tx_data", color: "#555" },
    { label: "Merkle Proof", desc: "txid + path_bits + siblings", color: "#555" },
    { label: "Stealth Data", desc: "Unified in StealthAnnouncement (type: 0=deposit, 1=transfer)", color: "#6a1b9a" },
  ];
  for (let i = 0; i < legendItems.length; i++) {
    const item = legendItems[i];
    els.push(
      text(1600, legendY + i * 26, `${item.label}`, {
        fontSize: 11,
        strokeColor: item.color,
        textAlign: "left",
      })
    );
    els.push(
      text(1760, legendY + i * 26, `${item.desc}`, {
        fontSize: 10,
        strokeColor: "#666",
        textAlign: "left",
      })
    );
  }

  writeExcalidraw("deposit-withdraw-flow", els);
}

function generateCryptoKeyModel() {
  const els: any[] = [];

  // === SECTION A: Key Hierarchy ===
  els.push(
    text(20, 10, "Key Hierarchy & Derivation", {
      fontSize: 26,
      strokeColor: "#1e1e1e",
      textAlign: "left",
    })
  );

  // Spending Key diamond
  els.push(
    ...labeledDiamond(200, 60, 280, 80, "Spending Key (Baby Jubjub)", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 14,
    })
  );

  // Three branches
  const branchY = 190;
  els.push(
    ...labeledRect(50, branchY, 200, 50, "Spending Pub\n(BJJ point)", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(270, branchY, 200, 50, "Nullifying Key\n(BN254 scalar)", {
      backgroundColor: "#ffe0b2",
      strokeColor: "#e65100",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(490, branchY, 200, 50, "Viewing Key\n(Ed25519)", {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      fontSize: 13,
    })
  );

  // Arrows from diamond to three branches
  els.push(arrow(280, 140, [[0, 0], [-130, 50]], { strokeColor: "#333" }));
  els.push(arrow(340, 140, [[0, 0], [30, 50]], { strokeColor: "#333" }));
  els.push(arrow(400, 140, [[0, 0], [190, 50]], { strokeColor: "#333" }));

  // MPK ellipse
  els.push(
    ...labeledEllipse(80, 290, 520, 55, "MPK = Poseidon(spendPub.x, spendPub.y, nullKey)", {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      fontSize: 13,
    })
  );

  // Arrows from branches to MPK
  els.push(arrow(150, 240, [[0, 0], [190, 50]], { strokeColor: "#333" }));
  els.push(arrow(370, 240, [[0, 0], [-30, 50]], { strokeColor: "#333" }));

  // NPK ellipse
  els.push(
    ...labeledEllipse(160, 390, 360, 50, "NPK = Poseidon(MPK, random)", {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      fontSize: 13,
    })
  );
  els.push(arrow(340, 345, [[0, 0], [0, 45]], { strokeColor: "#333" }));

  // Commitment & Nullifier
  els.push(
    ...labeledRect(40, 490, 320, 65, "Commitment = Poseidon(NPK, token, amount)\ntoken = ZKBTC_TOKEN_ID (0x7a627463)", {
      backgroundColor: "#e8eaf6",
      strokeColor: "#283593",
      fontSize: 12,
    })
  );
  els.push(
    ...labeledRect(380, 490, 310, 50, "Nullifier = Poseidon(nullKey, leafIndex)", {
      backgroundColor: "#fce4ec",
      strokeColor: "#c62828",
      fontSize: 12,
    })
  );
  els.push(arrow(260, 440, [[0, 0], [-60, 50]], { strokeColor: "#333" }));
  els.push(arrow(420, 440, [[0, 0], [115, 50]], { strokeColor: "#333" }));

  // Destinations
  els.push(
    ...labeledRect(80, 570, 220, 40, "Merkle Tree (depth 16)", {
      backgroundColor: "#e8eaf6",
      strokeColor: "#283593",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(420, 570, 220, 40, "Nullifier Registry", {
      backgroundColor: "#fce4ec",
      strokeColor: "#c62828",
      fontSize: 13,
    })
  );
  els.push(arrow(200, 540, [[0, 0], [0, 30]], { strokeColor: "#333" }));
  els.push(arrow(530, 540, [[0, 0], [0, 30]], { strokeColor: "#333" }));

  // === SECTION B: Stealth Address Protocol ===
  const sx = 780;
  els.push(
    text(sx, 10, "Stealth Address Protocol (EIP-5564)", {
      fontSize: 24,
      strokeColor: "#1e1e1e",
      textAlign: "left",
    })
  );

  // Column labels
  els.push(text(sx + 50, 55, "SENDER", { fontSize: 18, strokeColor: "#2e7d32" }));
  els.push(text(sx + 480, 55, "RECIPIENT", { fontSize: 18, strokeColor: "#1565c0" }));

  // Sender side
  els.push(
    ...labeledRect(sx, 90, 210, 45, "eph_priv (Ed25519)", {
      backgroundColor: "#c8e6c9",
      fontSize: 13,
    })
  );
  els.push(arrow(sx + 105, 135, [[0, 0], [0, 30]], { strokeColor: "#2e7d32" }));
  els.push(
    ...labeledRect(sx + 20, 170, 170, 40, "eph_pub", {
      backgroundColor: "#c8e6c9",
      fontSize: 14,
    })
  );

  // On-chain announcement (center)
  els.push(
    ...labeledRect(sx + 120, 240, 280, 45, "On-Chain: StealthAnnouncement\n(90B, unified deposit+transfer)", {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      strokeStyle: "dashed",
      fontSize: 13,
    })
  );
  els.push(arrow(sx + 105, 210, [[0, 0], [155, 30]], { strokeColor: "#f57f17" }));

  // Recipient side
  els.push(
    ...labeledRect(sx + 380, 90, 220, 45, "viewing_priv (Ed25519)", {
      backgroundColor: "#bbdefb",
      fontSize: 13,
    })
  );
  els.push(arrow(sx + 400, 262, [[0, 0], [90, 0]], { strokeColor: "#f57f17" }));

  // ECDH
  els.push(
    ...labeledRect(sx, 310, 180, 40, "X25519 ECDH", {
      backgroundColor: "#e8eaf6",
      fontSize: 14,
    })
  );
  els.push(
    ...labeledRect(sx + 380, 310, 180, 40, "X25519 ECDH", {
      backgroundColor: "#e8eaf6",
      fontSize: 14,
    })
  );
  els.push(arrow(sx + 105, 285, [[0, 0], [0, 25]], { strokeColor: "#333" }));
  els.push(arrow(sx + 490, 135, [[0, 0], [0, 175]], { strokeColor: "#333" }));

  // Shared secret
  els.push(
    ...labeledEllipse(sx + 170, 370, 200, 40, "shared_secret", {
      backgroundColor: "#ffecb3",
      strokeColor: "#ff6f00",
      fontSize: 14,
    })
  );
  els.push(arrow(sx + 90, 350, [[0, 0], [110, 30]], { strokeColor: "#ff6f00" }));
  els.push(arrow(sx + 470, 350, [[0, 0], [-130, 30]], { strokeColor: "#ff6f00" }));
  // "same!" label
  els.push(text(sx + 380, 380, "same!", { fontSize: 12, strokeColor: "#ff6f00" }));

  // Stealth pub
  els.push(
    ...labeledRect(sx, 430, 180, 40, "stealth_pub (BJJ)", {
      backgroundColor: "#dcedc8",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(sx + 380, 430, 180, 40, "stealth_pub (BJJ)", {
      backgroundColor: "#dcedc8",
      fontSize: 13,
    })
  );
  els.push(arrow(sx + 270, 400, [[0, 0], [-180, 30]], { strokeColor: "#333" }));
  els.push(arrow(sx + 270, 400, [[0, 0], [200, 30]], { strokeColor: "#333" }));

  // Commitment
  els.push(
    ...labeledRect(sx + 20, 500, 150, 40, "commitment", {
      backgroundColor: "#e8eaf6",
      fontSize: 14,
    })
  );
  els.push(arrow(sx + 90, 470, [[0, 0], [0, 30]], { strokeColor: "#333" }));

  // Scan + claim
  els.push(
    ...labeledRect(sx + 360, 500, 230, 50, "scan + detect + transact\n(JoinSplit 1x2 proof)", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 13,
    })
  );
  els.push(arrow(sx + 470, 470, [[0, 0], [0, 30]], { strokeColor: "#2e7d32" }));

  writeExcalidraw("crypto-key-model", els);
}

function generateJoinSplitCircuit() {
  const els: any[] = [];

  // Circuit boundary
  els.push(
    rect(20, 20, 1160, 990, {
      backgroundColor: "#fafafa",
      strokeColor: "#333",
      strokeWidth: 3,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(40, 35, "JoinSplit(N, M, depth=16) Circuit", {
      fontSize: 26,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  // === PRIVATE INPUTS ===
  els.push(
    rect(40, 80, 280, 280, {
      backgroundColor: "#f5f5f5",
      strokeColor: "#616161",
      strokeWidth: 2,
    })
  );
  els.push(
    text(60, 90, "PRIVATE INPUTS", {
      fontSize: 18,
      strokeColor: "#616161",
      textAlign: "left",
    })
  );
  const privateInputs = [
    "spendingKey (BJJ)",
    "nullifyingKey",
    "random[M]",
    "amount[N+M]",
    "token",
    "merklePathElements[N][16]",
    "merklePathIndices[N][16]",
  ];
  privateInputs.forEach((label, i) => {
    els.push(
      text(60, 125 + i * 30, `\u2022 ${label}`, {
        fontSize: 14,
        strokeColor: "#424242",
        textAlign: "left",
      })
    );
  });

  // === PUBLIC INPUTS ===
  els.push(
    rect(880, 80, 280, 200, {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(900, 90, "PUBLIC INPUTS", {
      fontSize: 18,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  const publicInputs = [
    "merkleRoot",
    "boundParamsHash",
    "nullifiers[N]",
    "commitmentsOut[M]",
  ];
  publicInputs.forEach((label, i) => {
    els.push(
      text(900, 125 + i * 30, `\u2022 ${label}`, {
        fontSize: 14,
        strokeColor: "#0d47a1",
        textAlign: "left",
      })
    );
  });

  // === VERIFICATION STEPS ===
  els.push(
    text(60, 400, "VERIFICATION STEPS", {
      fontSize: 20,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  // Row 1
  const row1Y = 440;
  const stepW = 340;
  const stepH = 80;
  const stepGap = 30;

  els.push(
    ...labeledRect(50, row1Y, stepW, stepH, "1. MPK Check\nspendingPub matches\nMPK derivation", {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(50 + stepW + stepGap, row1Y, stepW, stepH, "2. Merkle Proof\nVerify each input in\ntree (depth 16)", {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(50 + 2 * (stepW + stepGap), row1Y, stepW, stepH, "3. Nullifier Derivation\nPoseidon(nullKey,\nleafIndex)", {
      backgroundColor: "#fff3e0",
      strokeColor: "#e65100",
      fontSize: 13,
    })
  );

  // Arrows between row 1
  els.push(arrow(50 + stepW, row1Y + stepH / 2, [[0, 0], [stepGap, 0]], { strokeColor: "#333" }));
  els.push(arrow(50 + stepW + stepGap + stepW, row1Y + stepH / 2, [[0, 0], [stepGap, 0]], { strokeColor: "#333" }));

  // Row 2
  const row2Y = row1Y + stepH + 40;
  els.push(
    ...labeledRect(50, row2Y, stepW, stepH, "4. Output Commitments\nPoseidon(NPK, token, amount)\n+ 120-bit range check", {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      fontSize: 13,
    })
  );
  els.push(
    ...labeledRect(50 + stepW + stepGap, row2Y, stepW, stepH, "5. Value Balance\n\u03A3 valueIn == \u03A3 valueOut", {
      backgroundColor: "#fce4ec",
      strokeColor: "#c62828",
      fontSize: 14,
    })
  );
  els.push(
    ...labeledRect(50 + 2 * (stepW + stepGap), row2Y, stepW, stepH, "6. EdDSA-Poseidon\nSignature Verification", {
      backgroundColor: "#f3e5f5",
      strokeColor: "#6a1b9a",
      fontSize: 13,
    })
  );

  // Arrows between row 2
  els.push(arrow(50 + stepW, row2Y + stepH / 2, [[0, 0], [stepGap, 0]], { strokeColor: "#333" }));
  els.push(arrow(50 + stepW + stepGap + stepW, row2Y + stepH / 2, [[0, 0], [stepGap, 0]], { strokeColor: "#333" }));

  // Arrow from row 1 to row 2
  els.push(arrow(50 + 2 * (stepW + stepGap) + stepW / 2, row1Y + stepH, [[0, 0], [0, 20], [-2 * (stepW + stepGap), 20], [-2 * (stepW + stepGap), 40]], { strokeColor: "#333" }));

  // === OUTPUT ===
  els.push(
    rect(200, 740, 800, 50, {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      strokeWidth: 3,
    })
  );
  els.push(
    text(240, 750, "OUTPUT: Groth16 Proof — 256 bytes (2\u00D7G1 + 1\u00D7G2 on BN254)", {
      fontSize: 16,
      strokeColor: "#f57f17",
      textAlign: "left",
    })
  );
  els.push(
    text(240, 800, "Verified on-chain via alt_bn128 pairing syscalls (~85,000 CU)", {
      fontSize: 14,
      strokeColor: "#666",
      textAlign: "left",
    })
  );
  els.push(arrow(600, row2Y + stepH, [[0, 0], [0, 80]], { strokeColor: "#f57f17", strokeWidth: 3 }));

  // === CIRCUIT VARIANTS ===
  els.push(
    rect(20, 860, 1160, 130, {
      backgroundColor: "#fafafa",
      strokeColor: "#666",
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(40, 868, "Circuit Variants (N + M \u2264 14)", {
      fontSize: 16,
      strokeColor: "#333",
      textAlign: "left",
    })
  );
  els.push(
    text(50, 895, "Tier 1 (default): joinsplit_1x1, joinsplit_1x2, joinsplit_2x1, joinsplit_2x2", {
      fontSize: 12,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );
  els.push(
    text(50, 918, "Tier 2 (+6 more): joinsplit_1x3, _2x3, _3x1, _3x2, _3x3, _4x4", {
      fontSize: 12,
      strokeColor: "#e65100",
      textAlign: "left",
    })
  );
  els.push(
    text(50, 941, "All: 91 variants (N=1..13, M=1..14-N)", {
      fontSize: 12,
      strokeColor: "#999",
      textAlign: "left",
    })
  );
  els.push(
    text(50, 965, "Template: circuits/circom/joinsplit.circom \u2192 Generated: circuits/circom/generated/", {
      fontSize: 11,
      strokeColor: "#666",
      textAlign: "left",
    })
  );

  writeExcalidraw("joinsplit-circuit", els);
}

function generateFrostSigning() {
  const els: any[] = [];

  // === SECTION A: DKG ===
  els.push(
    rect(20, 20, 1360, 330, {
      backgroundColor: "#fff8e1",
      strokeColor: "#f57f17",
      strokeWidth: 2,
    })
  );
  els.push(
    text(40, 30, "Distributed Key Generation (DKG)", {
      fontSize: 24,
      strokeColor: "#f57f17",
      textAlign: "left",
    })
  );

  // Three signers
  const signerW = 180;
  const signerX = [200, 580, 960];
  const signerY = 80;
  for (let i = 0; i < 3; i++) {
    els.push(
      ...labeledRect(signerX[i], signerY, signerW, 50, `Signer ${i + 1}`, {
        backgroundColor: "#ffe0b2",
        strokeColor: "#e65100",
        fontSize: 16,
      })
    );
  }

  // Round 1
  els.push(
    ...labeledRect(300, 170, 800, 45, "Round 1: Generate Commitments \u2014 broadcast to all signers", {
      backgroundColor: "#fff9c4",
      fontSize: 14,
    })
  );
  for (let i = 0; i < 3; i++) {
    els.push(arrow(signerX[i] + signerW / 2, 130, [[0, 0], [0, 40]], { strokeColor: "#e65100" }));
  }

  // Round 2
  els.push(
    ...labeledRect(300, 240, 800, 45, "Round 2: Encrypted Key Shares \u2014 pairwise (X25519 / AES-256-GCM)", {
      backgroundColor: "#fff9c4",
      fontSize: 14,
    })
  );
  els.push(arrow(700, 215, [[0, 0], [0, 25]], { strokeColor: "#e65100" }));

  // Result
  els.push(
    ...labeledRect(350, 310, 700, 30, "Result: Group Public Key (Taproot-compatible secp256k1)", {
      backgroundColor: "#ffcc80",
      strokeColor: "#e65100",
      fontSize: 14,
    })
  );
  els.push(arrow(700, 285, [[0, 0], [0, 25]], { strokeColor: "#e65100" }));

  // Crypto module note
  els.push(
    text(350, 345, "crypto.rs: X25519/AES-256-GCM + commitment digest verification", {
      fontSize: 10,
      strokeColor: "#666",
      textAlign: "left",
    })
  );

  // === SECTION B: Signing ===
  els.push(
    rect(20, 380, 1460, 680, {
      backgroundColor: "#e8eaf6",
      strokeColor: "#283593",
      strokeWidth: 2,
    })
  );
  els.push(
    text(40, 390, "Redemption Signing (2-of-3) \u2014 Each signer independently validates before signing", {
      fontSize: 22,
      strokeColor: "#283593",
      textAlign: "left",
    })
  );

  // Backend sends request to all 3 signers
  els.push(
    ...labeledRect(560, 430, 300, 50, "Backend\n(coordinates signing rounds)", {
      backgroundColor: "#c5cae9",
      strokeColor: "#283593",
      fontSize: 14,
    })
  );

  // FrostClient coordination box
  els.push(
    ...labeledRect(440, 495, 540, 40, "FrostClient (frost_client.rs) — broadcast verification | session retry | round coordination", {
      backgroundColor: "#c5cae9",
      strokeColor: "#283593",
      strokeStyle: "dashed",
      fontSize: 11,
    })
  );
  els.push(arrow(710, 480, [[0, 0], [0, 15]], { strokeColor: "#283593" }));

  // Three signer columns, each with its own policy engine
  const colW = 400;
  const colGap = 40;
  const colStartX = [60, 520, 980];
  const colTopY = 560;

  for (let i = 0; i < 3; i++) {
    const cx = colStartX[i];

    // Arrow from backend down to this signer column
    els.push(arrow(660 + (i - 1) * 140, 480, [[0, 0], [(cx + colW / 2) - (660 + (i - 1) * 140), colTopY - 480 - 10]], { strokeColor: "#283593" }));

    // Signer container (dashed border)
    els.push(
      rect(cx, colTopY, colW, 440, {
        backgroundColor: i < 2 ? "#f5f5ff" : "#f5f5f5",
        strokeColor: i < 2 ? "#283593" : "#9e9e9e",
        strokeWidth: 2,
        strokeStyle: i < 2 ? "solid" : "dashed",
      })
    );

    const activeLabel = i < 2 ? `Signer ${i + 1} (active)` : `Signer 3 (standby)`;
    els.push(
      text(cx + 10, colTopY + 8, activeLabel, {
        fontSize: 16,
        strokeColor: i < 2 ? "#283593" : "#9e9e9e",
        textAlign: "left",
      })
    );

    // Policy Engine inside each signer
    els.push(
      ...labeledRect(cx + 20, colTopY + 45, colW - 40, 55, "Policy Engine", {
        backgroundColor: "#ffcdd2",
        strokeColor: "#c62828",
        fontSize: 14,
      })
    );

    // Policy checks text
    els.push(
      text(cx + 30, colTopY + 110, "\u2022 Recompute BIP-341 sighash\n\u2022 Verify UTXOs via Esplora\n\u2022 Check destination whitelist\n\u2022 Enforce amount/fee limits", {
        fontSize: 11,
        strokeColor: "#c62828",
        textAlign: "left",
      })
    );

    // Policy arrow down
    els.push(arrow(cx + colW / 2, colTopY + 100, [[0, 0], [0, 110]], { strokeColor: i < 2 ? "#2e7d32" : "#9e9e9e" }));

    // Pass/reject label
    if (i < 2) {
      els.push(
        text(cx + colW / 2 + 10, colTopY + 155, "\u2713 pass", {
          fontSize: 12,
          strokeColor: "#2e7d32",
          textAlign: "left",
        })
      );
    }

    // Round 1: Nonce Commitment
    els.push(
      ...labeledRect(cx + 20, colTopY + 220, colW - 40, 40, "Round 1: Nonce Commitment", {
        backgroundColor: i < 2 ? "#d1c4e9" : "#e0e0e0",
        strokeColor: i < 2 ? "#283593" : "#9e9e9e",
        fontSize: 13,
      })
    );

    // Arrow down
    els.push(arrow(cx + colW / 2, colTopY + 260, [[0, 0], [0, 20]], { strokeColor: i < 2 ? "#283593" : "#9e9e9e" }));

    // Round 2: Signature Share
    els.push(
      ...labeledRect(cx + 20, colTopY + 285, colW - 40, 40, "Round 2: Signature Share", {
        backgroundColor: i < 2 ? "#d1c4e9" : "#e0e0e0",
        strokeColor: i < 2 ? "#283593" : "#9e9e9e",
        fontSize: 13,
      })
    );

    // Audit log inside each signer
    els.push(
      ...labeledRect(cx + 20, colTopY + 350, colW - 40, 45, "Audit Log (JSONL)\npolicy | round1 | round2 | aggregate", {
        backgroundColor: "transparent",
        strokeColor: "#666",
        strokeStyle: "dashed",
        fontSize: 11,
      })
    );
  }

  // "(threshold = 2)" label between signer 1 and 2
  els.push(
    text(440, colTopY + 400, "(threshold = 2 \u2014 any 2 of 3 signers)", {
      fontSize: 14,
      strokeColor: "#283593",
    })
  );

  // Aggregate box below signer columns
  const aggY = colTopY + 460;
  els.push(
    ...labeledRect(300, aggY, 340, 50, "Aggregate \u2192 Schnorr Signature\n(BIP-340)", {
      backgroundColor: "#ffcc80",
      strokeColor: "#e65100",
      fontSize: 15,
    })
  );

  // Arrows from signer 1 & 2 down to aggregate
  els.push(arrow(colStartX[0] + colW / 2, colTopY + 440, [[0, 0], [300 + 170 - (colStartX[0] + colW / 2), aggY - (colTopY + 440)]], { strokeColor: "#283593" }));
  els.push(arrow(colStartX[1] + colW / 2, colTopY + 440, [[0, 0], [300 + 170 - (colStartX[1] + colW / 2), aggY - (colTopY + 440)]], { strokeColor: "#283593" }));

  // BTC broadcast
  els.push(
    ...labeledRect(740, aggY, 300, 50, "BTC Transaction Broadcast", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 16,
    })
  );
  els.push(arrow(640, aggY + 25, [[0, 0], [100, 0]], { strokeColor: "#2e7d32" }));

  writeExcalidraw("frost-signing", els);
}

// =====================================================================
// DIAGRAM 6: STEALTH ANNOUNCEMENT — Unified 90-byte layout
// =====================================================================

function generateStealthAnnouncement() {
  const els: any[] = [];

  // Title
  els.push(
    text(40, 20, "StealthAnnouncement — Unified 90-Byte On-Chain Layout", {
      fontSize: 24,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );

  // --- Byte layout visualization ---
  const byteY = 80;
  const fieldH = 50;
  const gapY = 4;
  const labelW = 150;
  const fieldX = 180;

  const fields = [
    { name: "discriminator", size: 1, offset: 0, value: "0x08", color: "#e8eaf6", border: "#3f51b5" },
    { name: "announcement_type", size: 1, offset: 1, value: "0=deposit, 1=transfer", color: "#fff3e0", border: "#e65100" },
    { name: "ephemeral_pub", size: 32, offset: 2, value: "Ed25519 ephemeral public key (ECDH scanning)", color: "#e8f5e9", border: "#2e7d32" },
    { name: "amount_bytes", size: 8, offset: 34, value: "plaintext u64 LE (type=0) | XOR-encrypted (type=1)", color: "#fff9c4", border: "#f57f17" },
    { name: "commitment", size: 32, offset: 42, value: "Poseidon(npk, ZKBTC_TOKEN_ID, amount)", color: "#f3e5f5", border: "#6a1b9a" },
    { name: "leaf_index", size: 8, offset: 74, value: "Merkle tree position (u64 LE)", color: "#e3f2fd", border: "#1565c0" },
    { name: "created_at", size: 8, offset: 82, value: "Unix timestamp (i64 LE)", color: "#efebe9", border: "#795548" },
  ];

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const y = byteY + i * (fieldH + gapY);
    // Width proportional to byte size (min 80, scale 32 → 640)
    const fieldW = Math.max(80, f.size * 20);

    // Offset label
    els.push(
      text(20, y + 8, `[${f.offset}]`, {
        fontSize: 12,
        strokeColor: "#666",
        textAlign: "left",
      })
    );

    // Size label
    els.push(
      text(60, y + 8, `${f.size}B`, {
        fontSize: 12,
        strokeColor: "#999",
        textAlign: "left",
      })
    );

    // Field name
    els.push(
      text(100, y + 8, f.name, {
        fontSize: 13,
        strokeColor: f.border,
        textAlign: "left",
      })
    );

    // Field box
    els.push(
      ...labeledRect(fieldX, y, fieldW, fieldH - 4, f.value, {
        backgroundColor: f.color,
        strokeColor: f.border,
        fontSize: 10,
      })
    );
  }

  // Total size annotation
  const totalY = byteY + fields.length * (fieldH + gapY) + 10;
  els.push(
    ...labeledRect(fieldX, totalY, 200, 30, "Total: 90 bytes", {
      backgroundColor: "#e0e0e0",
      strokeColor: "#333",
      fontSize: 14,
    })
  );

  // --- PDA Seeds section ---
  const seedsY = totalY + 60;
  els.push(
    text(40, seedsY, "PDA Seeds", {
      fontSize: 18,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );

  // Deposit PDA
  els.push(
    ...labeledRect(40, seedsY + 35, 300, 45, 'Deposits: ["stealth", txid]\nPrevents double-verification of same BTC txid', {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 11,
    })
  );

  // Transfer PDA
  els.push(
    ...labeledRect(360, seedsY + 35, 320, 45, 'Transfers: ["stealth", ephemeral_pub]\nPrevents replay of JoinSplit outputs', {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      fontSize: 11,
    })
  );

  // --- Deposit vs Transfer comparison ---
  const compY = seedsY + 110;
  els.push(
    text(40, compY, "Deposit (type=0) vs Transfer (type=1)", {
      fontSize: 18,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );

  // Deposit example
  els.push(
    rect(40, compY + 35, 330, 140, {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      strokeWidth: 2,
    })
  );
  els.push(
    text(50, compY + 40, "DEPOSIT (type=0)", {
      fontSize: 14,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );
  els.push(
    text(50, compY + 65, "• Created by: complete_deposit\n• amount_bytes: plaintext u64 LE\n• PDA seed: [\"stealth\", btc_txid]\n• Scanning: read amount directly\n• Source: SPV-verified BTC deposit", {
      fontSize: 10,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  // Transfer example
  els.push(
    rect(390, compY + 35, 330, 140, {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(400, compY + 40, "TRANSFER (type=1)", {
      fontSize: 14,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  els.push(
    text(400, compY + 65, "• Created by: transact (JoinSplit)\n• amount_bytes: XOR-encrypted\n• PDA seed: [\"stealth\", ephemeral_pub]\n• Scanning: XOR decrypt with shared secret\n• Source: JoinSplit N→M proof output", {
      fontSize: 10,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  writeExcalidraw("stealth-announcement", els);
}

// =====================================================================
// DIAGRAM 7: DEPOSIT LIFECYCLE EXAMPLE — Concrete values walkthrough
// =====================================================================

function generateDepositLifecycleExample() {
  const els: any[] = [];

  els.push(
    text(40, 20, "Deposit Lifecycle — Concrete Example", {
      fontSize: 24,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );

  const phases = [
    {
      title: "1. Key Generation (Client)",
      color: "#6a1b9a",
      bg: "#f3e5f5",
      y: 70,
      items: [
        "spendingKey (BJJ): 0x1a2b3c...",
        "nullifyingKey (BN254): 0x4d5e6f...",
        "viewingKey (Ed25519): 0x7a8b9c...",
        "MPK = Poseidon(spendPub.x, .y, nullKey)",
        "random = SHA256(ECDH(eph, viewPub) || \"random\")",
        "NPK = Poseidon(MPK, random) → 0x0105484d...",
      ],
    },
    {
      title: "2. BTC Transaction",
      color: "#e65100",
      bg: "#fff3e0",
      y: 240,
      items: [
        "Taproot address: bcrt1pg9m38jg7vh...",
        "Amount: 0.0001 BTC (10,000 sats)",
        "OP_RETURN (64 bytes):",
        "  ephemeralPub: 602421547c9d68f4... (32B)",
        "  npk: 0105484de40efa36... (32B)",
        "Txid: 8fe301035...",
      ],
    },
    {
      title: "3. Backend Processing",
      color: "#e65100",
      bg: "#ffe0b2",
      y: 420,
      items: [
        "Deposit Tracker: detects tx at block 370",
        "Wait 6+ confirmations (block 376)",
        "Sweep: single P2TR output to pool wallet",
        "  (NO OP_RETURN in sweep tx)",
        "Header Relayer: submits headers 370→376",
      ],
    },
    {
      title: "4. SPV Verification (On-Chain)",
      color: "#00695c",
      bg: "#e0f2f1",
      y: 590,
      items: [
        "Upload non-witness tx to ChadBuffer (212 bytes)",
        "Merkle proof: 1 sibling, tx_index: 1",
        "verify_transaction: validates in btc-light-client",
        "complete_deposit:",
        "  commitment = Poseidon(npk, 0x7a627463, 10000)",
        "  → 0x09310e6e53c316...",
      ],
    },
    {
      title: "5. On-Chain Result",
      color: "#1565c0",
      bg: "#e3f2fd",
      y: 770,
      items: [
        "StealthAnnouncement PDA (90 bytes):",
        "  discriminator: 0x08",
        "  announcement_type: 0 (deposit)",
        "  ephemeral_pub: 602421547c9d68f4...",
        "  amount_bytes: 10000 (plaintext)",
        "  commitment: 09310e6e53c316...",
        "  leaf_index: 0",
      ],
    },
  ];

  for (const phase of phases) {
    // Phase background
    els.push(
      rect(30, phase.y, 720, 155, {
        backgroundColor: phase.bg,
        strokeColor: phase.color,
        strokeWidth: 2,
      })
    );
    // Title
    els.push(
      text(45, phase.y + 8, phase.title, {
        fontSize: 15,
        strokeColor: phase.color,
        textAlign: "left",
      })
    );
    // Items
    els.push(
      text(50, phase.y + 32, phase.items.join("\n"), {
        fontSize: 10,
        strokeColor: "#333",
        textAlign: "left",
      })
    );
  }

  // Arrows between phases
  for (let i = 0; i < phases.length - 1; i++) {
    const fromY = phases[i].y + 155;
    const toY = phases[i + 1].y;
    const midX = 390;
    els.push(
      arrow(midX, fromY, [[0, 0], [0, toY - fromY]], {
        strokeColor: "#666",
      })
    );
  }

  writeExcalidraw("deposit-lifecycle-example", els);
}

// =====================================================================
// DIAGRAM 8: COMMITMENT TREE — Merkle tree visualization
// =====================================================================

function generateCommitmentTree() {
  const els: any[] = [];

  els.push(
    text(40, 20, "Commitment Tree — Incremental Poseidon Merkle Tree (depth 16)", {
      fontSize: 22,
      strokeColor: "#6a1b9a",
      textAlign: "left",
    })
  );

  // --- Tree visual (showing top 4 levels of depth-16 tree) ---
  const treeX = 400;
  const treeY = 80;
  const nodeW = 80;
  const nodeH = 35;
  const levelGap = 70;

  // Root (level 0)
  els.push(
    ...labeledRect(treeX, treeY, 120, 40, "Root\n(current_root)", {
      backgroundColor: "#f3e5f5",
      strokeColor: "#6a1b9a",
      fontSize: 10,
    })
  );

  // Level 1
  const l1Left = treeX - 150;
  const l1Right = treeX + 150;
  const l1Y = treeY + levelGap;
  els.push(
    ...labeledRect(l1Left, l1Y, nodeW, nodeH, "H(L, R)", {
      backgroundColor: "#e8eaf6",
      strokeColor: "#3f51b5",
      fontSize: 10,
    })
  );
  els.push(
    ...labeledRect(l1Right, l1Y, nodeW, nodeH, "H(L, R)", {
      backgroundColor: "#e8eaf6",
      strokeColor: "#3f51b5",
      fontSize: 10,
    })
  );
  // Arrows from root to level 1
  els.push(arrow(treeX + 30, treeY + 40, [[0, 0], [l1Left - treeX - 30 + 40, levelGap - 40]], { strokeColor: "#6a1b9a" }));
  els.push(arrow(treeX + 90, treeY + 40, [[0, 0], [l1Right - treeX - 90 + 40, levelGap - 40]], { strokeColor: "#6a1b9a" }));

  // Level 2
  const l2Y = l1Y + levelGap;
  const l2Positions = [l1Left - 80, l1Left + 80, l1Right - 80, l1Right + 80];
  for (const x of l2Positions) {
    els.push(
      ...labeledRect(x, l2Y, nodeW, nodeH, "H(L, R)", {
        backgroundColor: "#e8eaf6",
        strokeColor: "#3f51b5",
        fontSize: 10,
      })
    );
  }
  // Arrows from level 1 to level 2
  els.push(arrow(l1Left + 20, l1Y + nodeH, [[0, 0], [-60, levelGap - nodeH]], { strokeColor: "#3f51b5" }));
  els.push(arrow(l1Left + 60, l1Y + nodeH, [[0, 0], [60, levelGap - nodeH]], { strokeColor: "#3f51b5" }));
  els.push(arrow(l1Right + 20, l1Y + nodeH, [[0, 0], [-60, levelGap - nodeH]], { strokeColor: "#3f51b5" }));
  els.push(arrow(l1Right + 60, l1Y + nodeH, [[0, 0], [60, levelGap - nodeH]], { strokeColor: "#3f51b5" }));

  // Ellipsis for middle levels
  const ellY = l2Y + levelGap;
  els.push(
    text(treeX + 20, ellY, "···  depth 16 (12 more levels)  ···", {
      fontSize: 14,
      strokeColor: "#999",
      textAlign: "center",
    })
  );

  // Leaf level
  const leafY = ellY + 50;
  const leafW = 65;
  const leafGap = 8;
  const leafStart = 100;
  const leaves = ["C₀", "C₁", "C₂", "C₃", "...", "...", "...", "C₆₅₅₃₅"];
  for (let i = 0; i < leaves.length; i++) {
    const isActive = i < 4;
    els.push(
      ...labeledRect(leafStart + i * (leafW + leafGap), leafY, leafW, 30, leaves[i], {
        backgroundColor: isActive ? "#c8e6c9" : "#f5f5f5",
        strokeColor: isActive ? "#2e7d32" : "#bbb",
        fontSize: 11,
      })
    );
  }
  els.push(
    text(leafStart, leafY + 38, "Commitments = Poseidon(npk, token, amount)", {
      fontSize: 10,
      strokeColor: "#666",
      textAlign: "left",
    })
  );

  // --- On-chain account layout ---
  const accY = leafY + 80;
  els.push(
    text(40, accY, "CommitmentTree Account (3824 bytes)", {
      fontSize: 18,
      strokeColor: "#6a1b9a",
      textAlign: "left",
    })
  );

  const accFields = [
    { name: "discriminator", size: "1B", offset: "0", desc: "0x05" },
    { name: "bump", size: "1B", offset: "1", desc: "PDA bump" },
    { name: "current_root", size: "32B", offset: "8", desc: "Latest Merkle root" },
    { name: "next_index", size: "8B", offset: "40", desc: "Next leaf index (u64)" },
    { name: "frontier", size: "512B", offset: "48", desc: "16 × 32B rightmost filled nodes" },
    { name: "root_history", size: "3200B", offset: "560", desc: "100 × 32B circular buffer" },
    { name: "root_history_index", size: "4B", offset: "3760", desc: "Current position (u32)" },
  ];

  for (let i = 0; i < accFields.length; i++) {
    const f = accFields[i];
    const y = accY + 30 + i * 26;
    els.push(
      text(50, y, `[${f.offset}] ${f.name} (${f.size})`, {
        fontSize: 11,
        strokeColor: "#6a1b9a",
        textAlign: "left",
      })
    );
    els.push(
      text(340, y, f.desc, {
        fontSize: 11,
        strokeColor: "#666",
        textAlign: "left",
      })
    );
  }

  // --- Properties box ---
  const propY = accY + 30 + accFields.length * 26 + 15;
  els.push(
    rect(40, propY, 500, 100, {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(50, propY + 10, "Properties:\n• Hash: Poseidon2 (BN254 scalar field)\n• Root history: 100 entries (front-running protection)\n• Zero hash: Pre-computed per level (matching circomlib)\n• Capacity: 65,536 leaves (2¹⁶)", {
      fontSize: 11,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  writeExcalidraw("commitment-tree", els);
}

// =====================================================================
// DIAGRAM 9: SCANNING FLOW — Unified deposit + transfer scanning
// =====================================================================

function generateScanningFlow() {
  const els: any[] = [];

  els.push(
    text(40, 20, "Unified Scanning Flow — Detecting Incoming Notes", {
      fontSize: 22,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );

  // --- Step 1: Fetch all announcements ---
  const s1Y = 70;
  els.push(
    ...labeledRect(40, s1Y, 260, 50, "1. Fetch all StealthAnnouncement\naccounts (disc = 0x08)", {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      fontSize: 11,
    })
  );
  els.push(arrow(300, s1Y + 25, [[0, 0], [40, 0]], { strokeColor: "#1565c0" }));

  // --- Step 2: For each announcement ---
  els.push(
    ...labeledRect(340, s1Y, 200, 50, "2. For each announcement:\nread ephemeral_pub (32B)", {
      backgroundColor: "#e3f2fd",
      strokeColor: "#1565c0",
      fontSize: 11,
    })
  );
  els.push(arrow(540, s1Y + 25, [[0, 0], [40, 0]], { strokeColor: "#1565c0" }));

  // --- Step 3: ECDH ---
  els.push(
    ...labeledRect(580, s1Y, 250, 50, "3. ECDH shared secret:\nX25519(viewingPriv, ephemeralPub)", {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      fontSize: 11,
    })
  );

  // --- Step 4: Derive stealth scalar ---
  const s4Y = s1Y + 75;
  els.push(
    ...labeledRect(40, s4Y, 250, 50, "4. Derive stealthScalar from\nshared secret + spending pub", {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      fontSize: 11,
    })
  );
  els.push(arrow(290, s4Y + 25, [[0, 0], [40, 0]], { strokeColor: "#2e7d32" }));

  // --- Step 5: Compute NPK ---
  els.push(
    ...labeledRect(330, s4Y, 220, 50, "5. Compute NPK:\nPoseidon(MPK, random)", {
      backgroundColor: "#f3e5f5",
      strokeColor: "#6a1b9a",
      fontSize: 11,
    })
  );
  els.push(arrow(550, s4Y + 25, [[0, 0], [40, 0]], { strokeColor: "#6a1b9a" }));

  // --- Step 6: Get amount ---
  const branchX = 590;
  els.push(
    rect(branchX, s4Y - 5, 260, 60, {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      strokeWidth: 2,
    })
  );
  els.push(
    text(branchX + 10, s4Y, "6. Get amount by type:", {
      fontSize: 12,
      strokeColor: "#f57f17",
      textAlign: "left",
    })
  );

  // Type 0 branch
  const branchY = s4Y + 70;
  els.push(
    ...labeledRect(branchX - 80, branchY, 200, 45, "type=0 (deposit):\namount = read u64 LE directly", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 10,
    })
  );
  // Type 1 branch
  els.push(
    ...labeledRect(branchX + 140, branchY, 200, 45, "type=1 (transfer):\namount = XOR decrypt with\nSHA256(sharedSecret)", {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      fontSize: 10,
    })
  );
  // Arrows from branch
  els.push(arrow(branchX + 80, s4Y + 55, [[0, 0], [-60, branchY - s4Y - 55]], { strokeColor: "#f57f17" }));
  els.push(arrow(branchX + 180, s4Y + 55, [[0, 0], [60, branchY - s4Y - 55]], { strokeColor: "#f57f17" }));

  // --- Step 7: Verify commitment ---
  const s7Y = branchY + 65;
  els.push(
    ...labeledRect(branchX - 40, s7Y, 340, 50, "7. Verify: Poseidon(npk, ZKBTC_TOKEN_ID, amount)\n== stored commitment → MATCH = mine!", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 12,
    })
  );
  // Arrows from both branches to verify
  els.push(arrow(branchX + 20, branchY + 45, [[0, 0], [90, s7Y - branchY - 45]], { strokeColor: "#2e7d32" }));
  els.push(arrow(branchX + 240, branchY + 45, [[0, 0], [-70, s7Y - branchY - 45]], { strokeColor: "#2e7d32" }));

  // --- Result box ---
  const resY = s7Y + 70;
  els.push(
    rect(40, resY, 810, 100, {
      backgroundColor: "#f5f5f5",
      strokeColor: "#666",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(50, resY + 10, "Result: ScannedNote { amount, ephemeralPub, stealthPub, leafIndex, commitment }\n\n• Unified: ONE scan loop handles both deposits and transfers\n• No separate DepositRecord parsing (removed)\n• Amount decryption is transparent based on type byte", {
      fontSize: 11,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  writeExcalidraw("scanning-flow", els);
}

// =====================================================================
// DIAGRAM 10: SWEEP TRANSACTION — Simplified sweep (no OP_RETURN)
// =====================================================================

function generateSweepTransaction() {
  const els: any[] = [];

  els.push(
    text(40, 20, "Sweep Transaction — Simplified (No OP_RETURN)", {
      fontSize: 22,
      strokeColor: "#e65100",
      textAlign: "left",
    })
  );

  // --- Before: Old sweep ---
  els.push(
    rect(40, 70, 400, 200, {
      backgroundColor: "#ffebee",
      strokeColor: "#c62828",
      strokeWidth: 2,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(50, 78, "BEFORE (deprecated)", {
      fontSize: 14,
      strokeColor: "#c62828",
      textAlign: "left",
    })
  );

  els.push(
    ...labeledRect(60, 110, 160, 40, "Input: Deposit UTXO\n(Taproot P2TR)", {
      backgroundColor: "#ffcdd2",
      strokeColor: "#c62828",
      fontSize: 10,
    })
  );
  els.push(arrow(220, 130, [[0, 0], [30, 0]], { strokeColor: "#c62828" }));
  els.push(
    ...labeledRect(250, 100, 170, 35, "Output 0: P2TR\nto pool wallet", {
      backgroundColor: "#ffcdd2",
      strokeColor: "#c62828",
      fontSize: 10,
    })
  );
  els.push(
    ...labeledRect(250, 145, 170, 35, "Output 1: OP_RETURN\ncommitment (32 bytes)", {
      backgroundColor: "#ffcdd2",
      strokeColor: "#c62828",
      fontSize: 10,
    })
  );
  els.push(
    text(60, 195, "~156 vbytes, 2 outputs", {
      fontSize: 11,
      strokeColor: "#c62828",
      textAlign: "left",
    })
  );
  els.push(
    text(60, 215, "OP_RETURN was redundant — Solana verifies\nvia VerifiedTransaction PDA", {
      fontSize: 10,
      strokeColor: "#999",
      textAlign: "left",
    })
  );

  // --- After: New sweep ---
  els.push(
    rect(480, 70, 400, 200, {
      backgroundColor: "#e8f5e9",
      strokeColor: "#2e7d32",
      strokeWidth: 2,
    })
  );
  els.push(
    text(490, 78, "AFTER (current)", {
      fontSize: 14,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );

  els.push(
    ...labeledRect(500, 110, 160, 40, "Input: Deposit UTXO\n(Taproot P2TR)", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 10,
    })
  );
  els.push(arrow(660, 130, [[0, 0], [30, 0]], { strokeColor: "#2e7d32" }));
  els.push(
    ...labeledRect(690, 110, 170, 40, "Output 0: P2TR\nto pool wallet", {
      backgroundColor: "#c8e6c9",
      strokeColor: "#2e7d32",
      fontSize: 10,
    })
  );
  els.push(
    text(500, 170, "~111 vbytes, 1 output", {
      fontSize: 11,
      strokeColor: "#2e7d32",
      textAlign: "left",
    })
  );
  els.push(
    text(500, 190, "Smaller tx = lower fees\nCommitment computed on-chain from\nnpk + amount in deposit OP_RETURN", {
      fontSize: 10,
      strokeColor: "#555",
      textAlign: "left",
    })
  );

  // Arrow from old to new
  els.push(arrow(440, 170, [[0, 0], [40, 0]], { strokeColor: "#333" }));

  // --- SPV Verification flow ---
  const spvY = 300;
  els.push(
    text(40, spvY, "SPV Verification: How Sweep Gets Verified On-Chain", {
      fontSize: 18,
      strokeColor: "#00695c",
      textAlign: "left",
    })
  );

  const steps = [
    { label: "Deposit Tx\n(user → taproot)\nOP_RETURN: eph+npk", bg: "#fff3e0", border: "#e65100" },
    { label: "Mine 1+ blocks\n(confirmation)", bg: "#fff3e0", border: "#e65100" },
    { label: "Sweep Tx\n(taproot → pool)\nP2TR only", bg: "#ffe0b2", border: "#e65100" },
    { label: "Mine 6+ blocks\n(SPV requirement)", bg: "#ffe0b2", border: "#e65100" },
    { label: "Upload sweep tx\nto ChadBuffer\n(non-witness)", bg: "#b2dfdb", border: "#00695c" },
    { label: "verify_transaction\n(btc-light-client)\nMerkle + headers", bg: "#b2dfdb", border: "#00695c" },
    { label: "verify_stealth_\ndeposit (UTXOpia)\ncompute commitment", bg: "#c8e6c9", border: "#2e7d32" },
    { label: "StealthAnnounce-\nment PDA created\n(90 bytes, type=0)", bg: "#a5d6a7", border: "#1b5e20" },
  ];

  const stepW = 100;
  const stepH = 55;
  const stepGap = 10;
  const startX = 40;
  const stepY = spvY + 35;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const x = startX + i * (stepW + stepGap);
    els.push(
      ...labeledRect(x, stepY, stepW, stepH, s.label, {
        backgroundColor: s.bg,
        strokeColor: s.border,
        fontSize: 8,
      })
    );
    if (i < steps.length - 1) {
      els.push(
        arrow(x + stepW, stepY + stepH / 2, [[0, 0], [stepGap, 0]], {
          strokeColor: "#666",
        })
      );
    }
  }

  // --- Fee comparison ---
  const feeY = stepY + 90;
  els.push(
    rect(40, feeY, 400, 70, {
      backgroundColor: "#fff9c4",
      strokeColor: "#f57f17",
      strokeWidth: 1,
      strokeStyle: "dashed",
    })
  );
  els.push(
    text(50, feeY + 8, "Fee Savings:\n• Old: 10 (overhead) + 58 (input) + 43 (P2TR) + 45 (OP_RETURN) ≈ 156 vbytes\n• New: 10 (overhead) + 58 (input) + 43 (P2TR) ≈ 111 vbytes\n• Savings: ~29% smaller transaction", {
      fontSize: 10,
      strokeColor: "#333",
      textAlign: "left",
    })
  );

  writeExcalidraw("sweep-transaction", els);
}

// ─── CLI ─────────────────────────────────────────────────────────────
const generators: Record<string, () => void> = {
  "system-overview": generateSystemOverview,
  "deposit-withdraw-flow": generateDepositWithdrawFlow,
  "crypto-key-model": generateCryptoKeyModel,
  "joinsplit-circuit": generateJoinSplitCircuit,
  "frost-signing": generateFrostSigning,
  "stealth-announcement": generateStealthAnnouncement,
  "deposit-lifecycle-example": generateDepositLifecycleExample,
  "commitment-tree": generateCommitmentTree,
  "scanning-flow": generateScanningFlow,
  "sweep-transaction": generateSweepTransaction,
};

const cmd = process.argv[2];

if (!cmd || cmd === "--help") {
  console.log("Usage: bun run generate.ts <diagram|all>");
  console.log("Diagrams:", Object.keys(generators).join(", "));
  process.exit(0);
}

if (cmd === "all") {
  for (const [name, gen] of Object.entries(generators)) {
    console.log(`Generating ${name}...`);
    gen();
  }
  console.log("Done! All diagrams generated.");
} else if (generators[cmd]) {
  generators[cmd]();
} else {
  console.error(`Unknown diagram: ${cmd}`);
  console.error("Available:", Object.keys(generators).join(", "));
  process.exit(1);
}
