export const SUI_GROTH16_MAX_PUBLIC_INPUTS = 8;

export interface JoinSplitCircuitShape {
  nInputs: number;
  nOutputs: number;
  nPublic: number;
}

export function joinSplitPublicInputCount(nInputs: number, nOutputs: number): number {
  return 2 + nInputs + nOutputs;
}

export function isSuiGroth16Compatible(shape: JoinSplitCircuitShape): boolean {
  return shape.nPublic <= SUI_GROTH16_MAX_PUBLIC_INPUTS;
}

export function joinSplitShape(nInputs: number, nOutputs: number): JoinSplitCircuitShape {
  return {
    nInputs,
    nOutputs,
    nPublic: joinSplitPublicInputCount(nInputs, nOutputs),
  };
}

