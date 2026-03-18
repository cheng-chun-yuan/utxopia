#!/usr/bin/env bun
/**
 * E2E Full Localnet Test — Orchestrator
 *
 * Runs all 9 steps in sequence. Each step is a separate process for isolation.
 *
 * Usage:
 *   bun run scripts/e2e/run-all.ts
 */

import { execSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const steps = [
  { file: "step1-infra.ts", label: "Infrastructure" },
  { file: "step2-tokens.ts", label: "Additional Tokens" },
  { file: "step3-btc-deposit.ts", label: "BTC Deposit (real)" },
  { file: "step4-demo-deposit.ts", label: "Demo Deposit" },
  { file: "step5-shield.ts", label: "Shield SPL Tokens" },
  { file: "step6-transfer.ts", label: "JoinSplit Transfer" },
  { file: "step7-unshield.ts", label: "Unshield tUSDC" },
  { file: "step8-btc-withdraw.ts", label: "BTC Withdrawal Request" },
  { file: "step9-summary.ts", label: "Summary" },
];

console.log("========================================");
console.log("Aegis E2E Full Localnet Test");
console.log("========================================\n");

const results: { label: string; passed: boolean; duration: number }[] = [];
let allPassed = true;

for (const step of steps) {
  const start = Date.now();
  const scriptPath = path.join(__dirname, step.file);

  try {
    execSync(`bun run ${scriptPath}`, {
      stdio: "inherit",
      timeout: 300_000, // 5 min per step
      env: { ...process.env },
    });
    results.push({ label: step.label, passed: true, duration: Date.now() - start });
  } catch (err: any) {
    results.push({ label: step.label, passed: false, duration: Date.now() - start });
    allPassed = false;
    console.error(`\nStep "${step.label}" FAILED — aborting remaining steps.\n`);
    break;
  }
}

// Print results
console.log("\n========================================");
console.log("Results");
console.log("========================================");

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const status = r.passed ? "PASS" : "FAIL";
  const dots = ".".repeat(Math.max(1, 40 - r.label.length));
  const secs = (r.duration / 1000).toFixed(1);
  console.log(`  Step ${i + 1}: ${r.label} ${dots} ${status} (${secs}s)`);
}

if (allPassed) {
  console.log("\nALL STEPS PASSED");
} else {
  console.log("\nSOME STEPS FAILED");
  process.exit(1);
}
