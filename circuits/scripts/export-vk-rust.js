#!/usr/bin/env node
/**
 * Export Groth16 verification key as Rust hex constants
 *
 * Usage:
 *   node scripts/export-vk-rust.js <circuit_name>
 *   node scripts/export-vk-rust.js joinsplit_1x2
 *   node scripts/export-vk-rust.js joinsplit_2x2 --full   # Include shared VK components
 *
 * Reads: build/<circuit>/<circuit>.vkey.json
 * Outputs: Rust code to stdout
 *
 * For JoinSplit variants, only DELTA_G2 and IC are circuit-specific.
 * ALPHA_G1, BETA_G2, GAMMA_G2 are shared across all variants from the same ceremony.
 *
 * Format matches solana-bn254's Ethereum precompile format:
 * - G1: [x_BE(32), y_BE(32)] = 64 bytes
 * - G2: [x_imag_BE(32), x_real_BE(32), y_imag_BE(32), y_real_BE(32)] = 128 bytes
 */

const fs = require("fs");
const path = require("path");

const circuitName = process.argv[2];
const fullMode = process.argv.includes("--full");

if (!circuitName) {
  console.error("Usage: node scripts/export-vk-rust.js <circuit_name> [--full]");
  console.error("Example: node scripts/export-vk-rust.js joinsplit_1x2");
  process.exit(1);
}

const vkeyPath = path.join(__dirname, "..", "build", circuitName, `${circuitName}.vkey.json`);

if (!fs.existsSync(vkeyPath)) {
  console.error(`Verification key not found: ${vkeyPath}`);
  console.error(`Run compile.sh and setup.sh first to generate keys.`);
  process.exit(1);
}

const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));

/**
 * Convert a decimal string field element to 32-byte big-endian hex
 */
function fieldToHex32(decStr) {
  let hex = BigInt(decStr).toString(16);
  return hex.padStart(64, "0");
}

/**
 * Format 32-byte hex as Rust array literal entries
 */
function hexToRustBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(`0x${hex.slice(i, i + 2)}`);
  }
  return bytes;
}

/**
 * Encode G1 point as [x_BE(32), y_BE(32)] = 64 bytes
 */
function encodeG1(point) {
  const xHex = fieldToHex32(point[0]);
  const yHex = fieldToHex32(point[1]);
  return hexToRustBytes(xHex + yHex);
}

/**
 * Encode G2 point as [x_imag_BE(32), x_real_BE(32), y_imag_BE(32), y_real_BE(32)] = 128 bytes
 */
function encodeG2(point) {
  const xReal = fieldToHex32(point[0][0]);
  const xImag = fieldToHex32(point[0][1]);
  const yReal = fieldToHex32(point[1][0]);
  const yImag = fieldToHex32(point[1][1]);
  return hexToRustBytes(xImag + xReal + yImag + yReal);
}

/**
 * Format a byte array as a multi-line Rust array
 */
function formatRustArray(bytes, indent = "    ") {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const chunk = bytes.slice(i, i + 8).join(", ");
    lines.push(`${indent}${chunk},`);
  }
  return lines.join("\n");
}

// Parse variant name to get (N, M)
const variantMatch = circuitName.match(/joinsplit_(\d+)x(\d+)/);
const variantLabel = variantMatch
  ? `JoinSplit(${variantMatch[1]}, ${variantMatch[2]}, 16)`
  : circuitName;

// Encode VK components
const deltaG2 = encodeG2(vkey.vk_delta_2);
const icPoints = vkey.IC.map(encodeG1);
const nPublic = vkey.nPublic;
const icCount = icPoints.length;

// Sanitize module name for Rust
const modName = circuitName.replace(/-/g, "_");

let output = "";

if (fullMode) {
  // Full mode: include shared VK components
  const alphaG1 = encodeG1(vkey.vk_alpha_1);
  const betaG2 = encodeG2(vkey.vk_beta_2);
  const gammaG2 = encodeG2(vkey.vk_gamma_2);

  output += `/// Shared verification key components (same for all variants from this ceremony)
/// DO NOT EDIT - regenerate with: node scripts/export-vk-rust.js ${circuitName} --full
pub mod common_vk {
    /// VK alpha (G1 point, 64 bytes)
    pub const ALPHA_G1: [u8; 64] = [
${formatRustArray(alphaG1)}
    ];

    /// VK beta (G2 point, 128 bytes)
    pub const BETA_G2: [u8; 128] = [
${formatRustArray(betaG2)}
    ];

    /// VK gamma (G2 point, 128 bytes)
    pub const GAMMA_G2: [u8; 128] = [
${formatRustArray(gammaG2)}
    ];
}

`;
}

// Circuit-specific VK (delta + IC)
output += `/// Verification key for ${variantLabel}
/// Generated from ${circuitName}.vkey.json
/// DO NOT EDIT - regenerate with: node scripts/export-vk-rust.js ${circuitName}
pub mod ${modName}_vk {
    /// Number of public inputs
    pub const NUM_PUBLIC_INPUTS: usize = ${nPublic};

    /// VK delta (G2 point, 128 bytes)
    pub const DELTA_G2: [u8; 128] = [
${formatRustArray(deltaG2)}
    ];

    /// IC points (${icCount} G1 points: 1 base + ${nPublic} public inputs)
    pub const IC: [[u8; 64]; ${icCount}] = [
`;

for (let i = 0; i < icCount; i++) {
  output += `        // IC[${i}]\n`;
  output += `        [\n`;
  output += formatRustArray(icPoints[i], "            ") + "\n";
  output += `        ],\n`;
}

output += `    ];
}
`;

console.log(output);
