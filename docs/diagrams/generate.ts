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

  // btc-relay Program (separate on-chain program)
  els.push(
    ...labeledRect(60, 340, 280, 80, "btc-relay Program\n(SPV Verification)\nS6rgPjCeBhk...", {
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

  // zVault Program outer box
  els.push(
    rect(440, 330, 900, 210, {
      backgroundColor: "#e1bee7",
      strokeColor: "#6a1b9a",
      strokeWidth: 2,
    })
  );
  els.push(
    text(460, 335, "zVault Program (Pinocchio)", {
      fontSize: 18,
      strokeColor: "#6a1b9a",
      textAlign: "left",
    })
  );

  // Inner boxes
  const innerY = 375;
  els.push(...labeledRect(460, innerY, 200, 55, "Commitment Tree\n(depth 16)", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(680, innerY, 180, 55, "Nullifier Registry", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(880, innerY, 200, 55, "Deposit Records\n(200B, stealth data)", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(460, innerY + 70, 200, 55, "Name Registry\n(.zkey)", { backgroundColor: "#f3e5f5", fontSize: 13 }));
  els.push(...labeledRect(680, innerY + 70, 180, 55, "VK Registry", { backgroundColor: "#f3e5f5", fontSize: 13 }));

  // Arrow between BTC Light Client and zVault
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
    ...labeledRect(400, 670, 600, 60, "@zvault/sdk\n(Note Mgmt | Proofs | Stealth | Taproot)", {
      backgroundColor: "#90caf9",
      fontSize: 14,
    })
  );

  // Client boxes (simple)
  const clientY = 770;
  els.push(...labeledRect(60, clientY, 200, 55, "Web App\n(Next.js)", { backgroundColor: "#bbdefb", fontSize: 14 }));
  els.push(...labeledRect(280, clientY, 200, 55, "Mobile App\n(Expo)", { backgroundColor: "#bbdefb", fontSize: 14 }));

  // Backend container (expanded)
  els.push(
    rect(510, clientY, 280, 100, {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(520, clientY + 5, "Backend (Rust)", {
      fontSize: 14,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  els.push(...labeledRect(520, clientY + 28, 80, 28, "Deposit\nTracker", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(608, clientY + 28, 80, 28, "Redemption\nService", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(696, clientY + 28, 80, 28, "Header\nRelayer (TS)", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));

  // FROST Server container (expanded)
  els.push(
    rect(820, clientY, 280, 100, {
      backgroundColor: "#bbdefb",
      strokeColor: "#1565c0",
      strokeWidth: 2,
    })
  );
  els.push(
    text(830, clientY + 5, "FROST Server", {
      fontSize: 14,
      strokeColor: "#1565c0",
      textAlign: "left",
    })
  );
  els.push(...labeledRect(830, clientY + 28, 75, 28, "Policy\nEngine", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(913, clientY + 28, 75, 28, "Audit\nLog", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(996, clientY + 28, 75, 28, "Crypto", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));
  els.push(...labeledRect(830, clientY + 64, 241, 28, "DKG + Signing (secp256k1-tr)", { backgroundColor: "#90caf9", strokeColor: "#1565c0", fontSize: 9 }));

  // Arrows from SDK to clients
  els.push(arrow(500, 730, [[0, 0], [-340, 40]], { strokeColor: "#1565c0" }));
  els.push(arrow(600, 730, [[0, 0], [-220, 40]], { strokeColor: "#1565c0" }));
  els.push(arrow(800, 730, [[0, 0], [-150, 40]], { strokeColor: "#1565c0" }));
  els.push(arrow(900, 730, [[0, 0], [60, 40]], { strokeColor: "#1565c0" }));

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
    ...labeledRect(550, sweepY, 250, 55, "FROST Sweep Tx\n(taproot addr → pool wallet)\n+ OP_RETURN: commitment", {
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
    text(45, 405, "Phase 3: SPV Verification via btc-relay Program (verify_stealth_deposit instruction)", {
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
    ...labeledRect(630, spvY, 170, 55, "Check 2+\nConfirmations\n(btc-relay program)", {
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
    ...labeledRect(1220, spvY, 170, 55, "Create Deposit\nRecord PDA\n(200 bytes)", {
      backgroundColor: "#a5d6a7",
      strokeColor: "#1b5e20",
      fontSize: 11,
    })
  );
  els.push(arrow(1390, spvY + 27, [[0, 0], [20, 0]], { strokeColor: "#1b5e20" }));
  els.push(
    ...labeledRect(1410, spvY, 150, 55, "Mint zBTC\nto Pool Vault\n(Token-2022)", {
      backgroundColor: "#a5d6a7",
      strokeColor: "#1b5e20",
      fontSize: 11,
    })
  );

  // SPV accounts annotation
  els.push(
    text(50, spvY + 65, "Accounts: pool_state | light_client | block_header | commitment_tree | deposit_record | chadbuffer | authority | system | zbtc_mint | pool_vault | token-2022 | btc_relay_program", {
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
    "Stealth Data\n(in DepositRecord)",
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
    "zBTC Burned\nfrom Pool\n(Token-2022)",
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
    { label: "OP_RETURN (sweep)", desc: "commitment(32)", color: "#e65100" },
    { label: "Commitment", desc: "Poseidon(npk, token, amount)", color: "#00695c" },
    { label: "Nullifier", desc: "Poseidon(nullKey, leafIndex)", color: "#c62828" },
    { label: "NPK", desc: "Poseidon(MPK, random)", color: "#6a1b9a" },
    { label: "MPK", desc: "Poseidon(spendPub.x, .y, nullKey)", color: "#6a1b9a" },
    { label: "Deposit Record", desc: "200 bytes PDA (seeded by txid)", color: "#1565c0" },
    { label: "Block Header", desc: "PDA at btc-relay (80-byte header)", color: "#e65100" },
    { label: "ChadBuffer", desc: "authority(32) + raw_tx_data", color: "#555" },
    { label: "Merkle Proof", desc: "txid + path_bits + siblings", color: "#555" },
    { label: "Stealth Data", desc: "Embedded in DepositRecord (not separate PDA)", color: "#6a1b9a" },
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
    ...labeledRect(40, 490, 320, 65, "Commitment = Poseidon(NPK, token, amount)\ntoken = ZBTC_TOKEN_ID (0x7a627463)", {
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
    ...labeledRect(sx + 120, 240, 280, 45, "On-Chain: DepositRecord\n(200B, includes stealth data)", {
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

// ─── CLI ─────────────────────────────────────────────────────────────
const generators: Record<string, () => void> = {
  "system-overview": generateSystemOverview,
  "deposit-withdraw-flow": generateDepositWithdrawFlow,
  "crypto-key-model": generateCryptoKeyModel,
  "joinsplit-circuit": generateJoinSplitCircuit,
  "frost-signing": generateFrostSigning,
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
