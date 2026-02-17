declare module "circomlibjs" {
  interface PoseidonField {
    e(n: bigint | number | string): unknown;
    toObject(v: unknown): bigint;
    toString(v: unknown): string;
  }

  export interface Poseidon {
    (inputs: unknown[]): unknown;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<Poseidon>;
}
