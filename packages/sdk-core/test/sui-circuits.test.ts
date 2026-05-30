import { expect, test } from "bun:test";
import { isSuiGroth16Compatible, joinSplitShape } from "../src/sui-circuits";

test("classifies Sui Groth16-compatible JoinSplit shapes", () => {
  expect(isSuiGroth16Compatible(joinSplitShape(2, 2))).toBe(true);
  expect(isSuiGroth16Compatible(joinSplitShape(5, 1))).toBe(true);
  expect(isSuiGroth16Compatible(joinSplitShape(6, 1))).toBe(false);
  expect(isSuiGroth16Compatible(joinSplitShape(2, 5))).toBe(false);
});

