declare module "snarkjs" {
  const groth16: {
    fullProve(
      input: Record<string, any>,
      wasmFile: string | Uint8Array,
      zkeyFile: string | Uint8Array
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(
      vkey: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>;
    exportSolidityCallData(
      proof: any,
      publicSignals: string[]
    ): Promise<string>;
  };
  export { groth16 };
}
