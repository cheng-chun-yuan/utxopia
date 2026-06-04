import { expect, test } from "bun:test";
import {
  assertSuiGroth16Compatible,
  isSolanaGroth16Compatible,
  isSuiGroth16Compatible,
  joinSplitCircuitName,
  joinSplitPublicInputLabels,
  joinSplitShape,
  parseJoinSplitCircuitName,
  supportedSolanaJoinSplitShapes,
  supportedSuiJoinSplitShapes,
} from "../src/sui-circuits";

test("classifies Sui Groth16-compatible JoinSplit shapes", () => {
  expect(isSuiGroth16Compatible(joinSplitShape(2, 2))).toBe(true);
  expect(isSuiGroth16Compatible(joinSplitShape(5, 1))).toBe(true);
  expect(isSuiGroth16Compatible(joinSplitShape(6, 1))).toBe(false);
  expect(isSuiGroth16Compatible(joinSplitShape(2, 5))).toBe(false);
});

test("uses one circuit naming and public input layout across chains", () => {
  const shape = joinSplitShape(2, 2);
  expect(shape.name).toBe("joinsplit_2x2");
  expect(joinSplitCircuitName(2, 2)).toBe("joinsplit_2x2");
  expect(parseJoinSplitCircuitName("joinsplit_2x2")).toEqual(shape);
  expect(joinSplitPublicInputLabels(2, 2)).toEqual([
    "merkleRoot",
    "boundParamsHash",
    "nullifiers[0]",
    "nullifiers[1]",
    "commitmentsOut[0]",
    "commitmentsOut[1]",
  ]);
});

test("keeps Sui and Solana on the same circuit catalog with chain-specific limits", () => {
  const suiNames = supportedSuiJoinSplitShapes().map((shape) => shape.name);
  const solanaNames = supportedSolanaJoinSplitShapes().map((shape) => shape.name);

  expect(suiNames).toContain("joinsplit_1x1");
  expect(suiNames).toContain("joinsplit_5x1");
  expect(suiNames).not.toContain("joinsplit_6x1");
  expect(solanaNames).toContain("joinsplit_6x1");
  expect(solanaNames).toContain("joinsplit_13x1");
});

test("rejects Sui verification key registration for unsupported public input counts", () => {
  expect(() => assertSuiGroth16Compatible(joinSplitShape(5, 1))).not.toThrow();
  expect(() => assertSuiGroth16Compatible(joinSplitShape(6, 1))).toThrow("supports at most 8");
  expect(isSolanaGroth16Compatible(joinSplitShape(6, 1))).toBe(true);
});

test("rejects invalid JoinSplit arities", () => {
  expect(() => joinSplitShape(0, 1)).toThrow("Unsupported JoinSplit arity");
  expect(() => joinSplitShape(1, 14)).toThrow("Unsupported JoinSplit arity");
  expect(() => parseJoinSplitCircuitName("transfer_2x2")).toThrow("Invalid JoinSplit circuit name");
});
