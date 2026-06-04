import { Transaction } from "@mysten/sui/transactions";
import type {
  MerkleRoot,
  Note,
  NoteScanInput,
  PoolState,
  RedemptionInput,
  RegisterVerifyingKeyInput,
  ShieldInput,
  SignedTransaction,
  SuiUnsignedTransaction,
  TransactionResult,
  TransactInput,
  UTXOpiaChainAdapter,
} from "@utxopia/sdk-core";
import {
  assertSuiGroth16Compatible,
  joinSplitShape,
} from "@utxopia/sdk-core";

export interface UTXOpiaSuiAdapterConfig {
  rpcUrl: string;
  packageId: string;
  poolObjectId: string;
  poolInitialSharedVersion?: number | string;
  btcDepositRegistryObjectId?: string;
  btcDepositRegistryInitialSharedVersion?: number | string;
  adminCapObjectId?: string;
  adminCapVersion?: string;
  adminCapDigest?: string;
  verifyingKeyRegistryObjectId?: string;
  verifyingKeyRegistryInitialSharedVersion?: number | string;
  nullifierRegistryObjectId?: string;
  nullifierRegistryInitialSharedVersion?: number | string;
  redemptionQueueObjectId?: string;
  redemptionQueueInitialSharedVersion?: number | string;
  redemptionCapObjectId?: string;
  redemptionCapVersion?: string;
  redemptionCapDigest?: string;
  indexerUrl?: string;
}

export class UTXOpiaSuiAdapter implements UTXOpiaChainAdapter {
  readonly chain = "sui" as const;

  constructor(private readonly config: UTXOpiaSuiAdapterConfig) {}

  async getPoolState(): Promise<PoolState> {
    return {
      chain: this.chain,
      poolId: this.config.poolObjectId,
      paused: false,
      latestMerkleRoot: "",
      treeDepth: 16,
    };
  }

  async getLatestMerkleRoot(): Promise<MerkleRoot> {
    return {
      root: "",
      index: 0,
      observedAt: new Date(0).toISOString(),
    };
  }

  async getNotes(_: NoteScanInput): Promise<Note[]> {
    if (!this.config.indexerUrl) {
      return [];
    }

    throw new Error("Sui note scanning requires the Sui indexer API implementation");
  }

  async buildShieldTransaction(input: ShieldInput): Promise<SuiUnsignedTransaction> {
    void input;
    throw new Error("Sui generic shield PTBs are disabled; use buildBtcDepositTransaction with a verified BTC deposit object");
  }

  async buildBtcDepositTransaction(input: {
    verifiedDepositObjectId: string;
    verifiedDepositVersion: string;
    verifiedDepositDigest: string;
  }): Promise<SuiUnsignedTransaction> {
    if (!this.config.btcDepositRegistryObjectId) {
      throw new Error("Sui BTC deposit registry object ID is required to build BTC deposit PTBs");
    }

    const tx = new Transaction();
    const verifiedDeposit = tx.objectRef({
      objectId: input.verifiedDepositObjectId,
      version: input.verifiedDepositVersion,
      digest: input.verifiedDepositDigest,
    });

    tx.moveCall({
      target: `${this.config.packageId}::btc_deposit::complete_verified_deposit`,
      arguments: [
        this.sharedObject(tx, this.config.poolObjectId, this.config.poolInitialSharedVersion, true),
        this.sharedObject(
          tx,
          this.config.btcDepositRegistryObjectId,
          this.config.btcDepositRegistryInitialSharedVersion,
          true,
        ),
        verifiedDeposit,
      ],
    });

    return this.buildPtb(tx, "Sui verified BTC deposit PTB", [
      input.verifiedDepositObjectId,
      this.config.poolObjectId,
      this.config.btcDepositRegistryObjectId,
    ]);
  }

  async buildTransactTransaction(input: TransactInput): Promise<SuiUnsignedTransaction> {
    if (!this.config.nullifierRegistryObjectId) {
      throw new Error("Sui nullifier registry object ID is required to build transact PTBs");
    }
    if (!this.config.verifyingKeyRegistryObjectId) {
      throw new Error("Sui verifying-key registry object ID is required to build transact PTBs");
    }
    if (!input.vkHash || !input.publicInputs || !input.proofPoints || !input.commitmentsOut) {
      throw new Error("Sui transact PTBs require vkHash, publicInputs, proofPoints, and commitmentsOut");
    }

    const tx = new Transaction();
    const nullifiers = input.nullifiers ?? input.inputNotes
      .map((note) => note.nullifier)
      .filter((nullifier): nullifier is string => Boolean(nullifier))
      .map(bytesFromHexOrUtf8);
    const nullifierBytes = nullifiers.map((bytes) => Array.from(bytes));
    const commitmentBytes = input.commitmentsOut.map((bytes) => Array.from(bytes));

    tx.moveCall({
      target: `${this.config.packageId}::transact::transact`,
      arguments: [
        this.sharedObject(tx, this.config.poolObjectId, this.config.poolInitialSharedVersion, true),
        this.sharedObject(
          tx,
          this.config.nullifierRegistryObjectId,
          this.config.nullifierRegistryInitialSharedVersion,
          true,
        ),
        this.sharedObject(
          tx,
          this.config.verifyingKeyRegistryObjectId,
          this.config.verifyingKeyRegistryInitialSharedVersion,
          false,
        ),
        tx.pure.u8(input.inputNotes.length),
        tx.pure.u8(input.outputs.length),
        tx.pure.vector("u8", input.vkHash),
        tx.pure.vector("u8", input.publicInputs),
        tx.pure.vector("u8", input.proofPoints),
        tx.pure("vector<vector<u8>>", nullifierBytes),
        tx.pure("vector<vector<u8>>", commitmentBytes),
      ],
    });

    return this.buildPtb(tx, "Sui private transfer PTB", [
      this.config.poolObjectId,
      this.config.nullifierRegistryObjectId,
      this.config.verifyingKeyRegistryObjectId,
    ]);
  }

  async buildRedemptionTransaction(input: RedemptionInput): Promise<SuiUnsignedTransaction> {
    if (!this.config.redemptionQueueObjectId) {
      throw new Error("Sui redemption queue object ID is required to build redemption PTBs");
    }
    if (!this.config.redemptionCapObjectId || !this.config.redemptionCapVersion || !this.config.redemptionCapDigest) {
      throw new Error("Sui redemption cap object ref is required to request redemptions");
    }

    const tx = new Transaction();
    const redemptionCap = tx.objectRef({
      objectId: this.config.redemptionCapObjectId,
      version: this.config.redemptionCapVersion,
      digest: this.config.redemptionCapDigest,
    });

    tx.moveCall({
      target: `${this.config.packageId}::redemption::request_redemption`,
      arguments: [
        redemptionCap,
        this.sharedObject(tx, this.config.poolObjectId, this.config.poolInitialSharedVersion, true),
        this.sharedObject(
          tx,
          this.config.redemptionQueueObjectId,
          this.config.redemptionQueueInitialSharedVersion,
          true,
        ),
        tx.pure.vector("u8", bytesFromHexOrUtf8(input.btcAddress)),
        tx.pure.u64(input.amountSats.toString()),
        tx.pure.u64(input.maxFeeSats.toString()),
      ],
    });

    return this.buildPtb(tx, "Sui BTC redemption request PTB", [
      this.config.redemptionCapObjectId,
      this.config.poolObjectId,
      this.config.redemptionQueueObjectId,
    ]);
  }

  async buildIkaApprovalTransaction(input: {
    redemptionId: bigint | number;
    sighash: Uint8Array;
  }): Promise<SuiUnsignedTransaction> {
    if (!this.config.redemptionQueueObjectId) {
      throw new Error("Sui redemption queue object ID is required to build Ika approval PTBs");
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.config.packageId}::ika_policy::approve_signing`,
      arguments: [
        this.sharedObject(tx, this.config.poolObjectId, this.config.poolInitialSharedVersion, false),
        this.sharedObject(
          tx,
          this.config.redemptionQueueObjectId,
          this.config.redemptionQueueInitialSharedVersion,
          false,
        ),
        tx.pure.u64(input.redemptionId.toString()),
        tx.pure.vector("u8", input.sighash),
      ],
    });

    return this.buildPtb(tx, "Sui Ika signing approval PTB", [
      this.config.poolObjectId,
      this.config.redemptionQueueObjectId,
    ]);
  }

  async buildCompleteRedemptionTransaction(input: {
    redemptionId: bigint | number;
    btcTxid: Uint8Array;
  }): Promise<SuiUnsignedTransaction> {
    if (!this.config.redemptionQueueObjectId) {
      throw new Error("Sui redemption queue object ID is required to build completion PTBs");
    }
    if (!this.config.redemptionCapObjectId || !this.config.redemptionCapVersion || !this.config.redemptionCapDigest) {
      throw new Error("Sui redemption cap object ref is required to complete redemptions");
    }

    const tx = new Transaction();
    const redemptionCap = tx.objectRef({
      objectId: this.config.redemptionCapObjectId,
      version: this.config.redemptionCapVersion,
      digest: this.config.redemptionCapDigest,
    });

    tx.moveCall({
      target: `${this.config.packageId}::redemption::complete_redemption`,
      arguments: [
        redemptionCap,
        this.sharedObject(tx, this.config.poolObjectId, this.config.poolInitialSharedVersion, false),
        this.sharedObject(
          tx,
          this.config.redemptionQueueObjectId,
          this.config.redemptionQueueInitialSharedVersion,
          true,
        ),
        tx.pure.u64(input.redemptionId.toString()),
        tx.pure.vector("u8", input.btcTxid),
      ],
    });

    return this.buildPtb(tx, "Sui BTC redemption completion PTB", [
      this.config.redemptionCapObjectId,
      this.config.poolObjectId,
      this.config.redemptionQueueObjectId,
    ]);
  }

  async buildRegisterVerifyingKeyTransaction(
    input: RegisterVerifyingKeyInput,
  ): Promise<SuiUnsignedTransaction> {
    if (!this.config.adminCapObjectId || !this.config.adminCapVersion || !this.config.adminCapDigest) {
      throw new Error("Sui admin cap object ref is required to register verifying keys");
    }
    if (!this.config.verifyingKeyRegistryObjectId) {
      throw new Error("Sui verifying-key registry object ID is required to register verifying keys");
    }
    const shape = joinSplitShape(input.nInputs, input.nOutputs);
    if (input.nPublic !== shape.nPublic) {
      throw new Error(`${shape.name} expects ${shape.nPublic} public inputs, got ${input.nPublic}`);
    }
    assertSuiGroth16Compatible(shape);

    const tx = new Transaction();
    const adminCap = tx.objectRef({
      objectId: this.config.adminCapObjectId,
      version: this.config.adminCapVersion,
      digest: this.config.adminCapDigest,
    });
    const registry = this.sharedObject(
      tx,
      this.config.verifyingKeyRegistryObjectId,
      this.config.verifyingKeyRegistryInitialSharedVersion,
      true,
    );

    if (input.rawVerifyingKey) {
      tx.moveCall({
        target: `${this.config.packageId}::verifier::register_raw_key`,
        arguments: [
          adminCap,
          registry,
          tx.pure.u8(input.nInputs),
          tx.pure.u8(input.nOutputs),
          tx.pure.u8(input.nPublic),
          tx.pure.vector("u8", input.vkHash),
          tx.pure.vector("u8", input.rawVerifyingKey),
        ],
      });
    } else {
      tx.moveCall({
        target: `${this.config.packageId}::verifier::register_prepared_key`,
        arguments: [
          adminCap,
          registry,
          tx.pure.u8(input.nInputs),
          tx.pure.u8(input.nOutputs),
          tx.pure.u8(input.nPublic),
          tx.pure.vector("u8", input.vkHash),
          tx.pure.vector("u8", input.vkGammaAbcG1Bytes),
          tx.pure.vector("u8", input.alphaG1BetaG2Bytes),
          tx.pure.vector("u8", input.gammaG2NegPcBytes),
          tx.pure.vector("u8", input.deltaG2NegPcBytes),
        ],
      });
    }

    return this.buildPtb(tx, "Sui register prepared verifying key PTB", [
      this.config.adminCapObjectId,
      this.config.verifyingKeyRegistryObjectId,
    ]);
  }

  async submitTransaction(_: SignedTransaction): Promise<TransactionResult> {
    throw new Error("Sui transaction submission is not implemented yet");
  }

  private async buildPtb(
    tx: Transaction,
    description: string,
    objectIds: string[],
  ): Promise<SuiUnsignedTransaction> {
    return {
      chain: this.chain,
      kind: "sui-programmable-transaction-block",
      bytes: await tx.build({ onlyTransactionKind: true }),
      description,
      packageId: this.config.packageId,
      objectIds,
    };
  }

  private sharedObject(
    tx: Transaction,
    objectId: string,
    initialSharedVersion: number | string | undefined,
    mutable: boolean,
  ) {
    if (initialSharedVersion === undefined) {
      throw new Error(`Initial shared version is required for Sui object ${objectId}`);
    }

    return tx.sharedObjectRef({
      objectId,
      initialSharedVersion,
      mutable,
    });
  }
}

function bytesFromHexOrUtf8(value: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]+$/.test(normalized) && normalized.length % 2 === 0) {
    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  return new TextEncoder().encode(value);
}
