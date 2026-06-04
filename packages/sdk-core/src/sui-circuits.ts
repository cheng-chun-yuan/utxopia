export const SUI_GROTH16_MAX_PUBLIC_INPUTS = 8;
export const SOLANA_GROTH16_MAX_PUBLIC_INPUTS = 16;
export const JOINSPLIT_MAX_TOTAL_ARITY = 14;
export const JOINSPLIT_PUBLIC_INPUT_PREFIX = [
  "merkleRoot",
  "boundParamsHash",
] as const;

export interface JoinSplitCircuitShape {
  name: `joinsplit_${number}x${number}`;
  nInputs: number;
  nOutputs: number;
  nPublic: number;
  publicInputs: readonly string[];
}

export function joinSplitPublicInputCount(nInputs: number, nOutputs: number): number {
  return 2 + nInputs + nOutputs;
}

export function joinSplitCircuitName(nInputs: number, nOutputs: number): `joinsplit_${number}x${number}` {
  assertJoinSplitArity(nInputs, nOutputs);
  return `joinsplit_${nInputs}x${nOutputs}`;
}

export function parseJoinSplitCircuitName(name: string): JoinSplitCircuitShape {
  const match = /^joinsplit_(\d+)x(\d+)$/.exec(name);
  if (!match) {
    throw new Error(`Invalid JoinSplit circuit name: ${name}`);
  }

  return joinSplitShape(Number(match[1]), Number(match[2]));
}

export function isSuiGroth16Compatible(shape: JoinSplitCircuitShape): boolean {
  return shape.nPublic <= SUI_GROTH16_MAX_PUBLIC_INPUTS;
}

export function assertSuiGroth16Compatible(shape: JoinSplitCircuitShape): void {
  if (!isSuiGroth16Compatible(shape)) {
    throw new Error(
      `${shape.name} has ${shape.nPublic} public inputs; Sui Groth16 currently supports at most ${SUI_GROTH16_MAX_PUBLIC_INPUTS}`,
    );
  }
}

export function isSolanaGroth16Compatible(shape: JoinSplitCircuitShape): boolean {
  return shape.nPublic <= SOLANA_GROTH16_MAX_PUBLIC_INPUTS;
}

export function joinSplitShape(nInputs: number, nOutputs: number): JoinSplitCircuitShape {
  assertJoinSplitArity(nInputs, nOutputs);
  return {
    name: `joinsplit_${nInputs}x${nOutputs}`,
    nInputs,
    nOutputs,
    nPublic: joinSplitPublicInputCount(nInputs, nOutputs),
    publicInputs: joinSplitPublicInputLabels(nInputs, nOutputs),
  };
}

export function joinSplitPublicInputLabels(nInputs: number, nOutputs: number): readonly string[] {
  assertJoinSplitArity(nInputs, nOutputs);
  return [
    ...JOINSPLIT_PUBLIC_INPUT_PREFIX,
    ...Array.from({ length: nInputs }, (_, index) => `nullifiers[${index}]`),
    ...Array.from({ length: nOutputs }, (_, index) => `commitmentsOut[${index}]`),
  ];
}

export function supportedSuiJoinSplitShapes(): readonly JoinSplitCircuitShape[] {
  return supportedJoinSplitShapes().filter(isSuiGroth16Compatible);
}

export function supportedSolanaJoinSplitShapes(): readonly JoinSplitCircuitShape[] {
  return supportedJoinSplitShapes().filter(isSolanaGroth16Compatible);
}

export function supportedJoinSplitShapes(): readonly JoinSplitCircuitShape[] {
  const shapes: JoinSplitCircuitShape[] = [];
  for (let nInputs = 1; nInputs < JOINSPLIT_MAX_TOTAL_ARITY; nInputs += 1) {
    for (let nOutputs = 1; nOutputs < JOINSPLIT_MAX_TOTAL_ARITY; nOutputs += 1) {
      if (nInputs + nOutputs <= JOINSPLIT_MAX_TOTAL_ARITY) {
        shapes.push(joinSplitShape(nInputs, nOutputs));
      }
    }
  }
  return shapes;
}

function assertJoinSplitArity(nInputs: number, nOutputs: number): void {
  if (!Number.isInteger(nInputs) || !Number.isInteger(nOutputs)) {
    throw new Error("JoinSplit arity must use integer input/output counts");
  }
  if (nInputs < 1 || nOutputs < 1 || nInputs + nOutputs > JOINSPLIT_MAX_TOTAL_ARITY) {
    throw new Error(
      `Unsupported JoinSplit arity ${nInputs}x${nOutputs}; expected nInputs >= 1, nOutputs >= 1, and nInputs + nOutputs <= ${JOINSPLIT_MAX_TOTAL_ARITY}`,
    );
  }
}
