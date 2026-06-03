import {
  Curve,
  Hash,
  IkaClient,
  IkaTransaction,
  SignatureAlgorithm,
  type UserShareEncryptionKeys,
  getNetworkConfig,
  type IkaConfig,
  type Network,
} from "@ika.xyz/sdk";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiUnsignedTransaction } from "@utxopia/sdk-core";

export interface UTXOpiaSuiIkaConfig {
  rpcUrl: string;
  network?: Network;
  ikaConfig?: IkaConfig;
  dWalletId?: string;
  dWalletCapObjectId?: string;
  networkEncryptionKeyId?: string;
  ikaCoinObjectId?: string;
  suiCoinObjectId?: string;
  suiPaymentReturnAddress?: string;
  encryptedUserSecretKeyShareId?: string;
  userShareEncryptionKeys?: UserShareEncryptionKeys;
}

export interface IkaObjectIds {
  dWalletId?: string;
  dWalletCapObjectId?: string;
  networkEncryptionKeyId?: string;
  ikaCoinObjectId?: string;
  suiCoinObjectId?: string;
}

export class UTXOpiaSuiIkaAdapter {
  readonly chain = "sui" as const;
  readonly ikaConfig: IkaConfig;

  constructor(private readonly config: UTXOpiaSuiIkaConfig) {
    this.ikaConfig = config.ikaConfig ?? getNetworkConfig(config.network ?? "testnet");
  }

  createClient(): IkaClient {
    return new IkaClient({
      suiClient: new SuiJsonRpcClient({
        url: this.config.rpcUrl,
        network: this.config.network ?? "testnet",
      }),
      config: this.ikaConfig,
      cache: true,
      encryptionKeyOptions: { autoDetect: true },
    });
  }

  async buildApproveTaprootMessageTransaction(input: {
    dWalletCapObjectId?: string;
    message: Uint8Array;
  }): Promise<SuiUnsignedTransaction> {
    const dWalletCapObjectId = input.dWalletCapObjectId ?? this.config.dWalletCapObjectId;
    if (!dWalletCapObjectId) {
      throw new Error("Ika dWalletCap object ID is required to approve Taproot messages");
    }
    assert32Bytes(input.message, "Taproot signing message");

    const tx = new Transaction();
    const ikaTx = this.createIkaTransaction(tx);
    ikaTx.approveMessage({
      dWalletCap: dWalletCapObjectId,
      curve: Curve.SECP256K1,
      signatureAlgorithm: SignatureAlgorithm.Taproot,
      hashScheme: Hash.SHA256,
      message: input.message,
    });

    return buildIkaPtb(this.config.rpcUrl, tx, "Ika Taproot message approval PTB", this.ikaConfig, [
      dWalletCapObjectId,
    ]);
  }

  async buildRequestGlobalTaprootPresignTransaction(input: Partial<IkaObjectIds> = {}): Promise<SuiUnsignedTransaction> {
    const networkEncryptionKeyId = input.networkEncryptionKeyId ?? this.config.networkEncryptionKeyId;
    const ikaCoinObjectId = input.ikaCoinObjectId ?? this.config.ikaCoinObjectId;
    const suiCoinObjectId = input.suiCoinObjectId ?? this.config.suiCoinObjectId;
    if (!networkEncryptionKeyId) {
      throw new Error("Ika network encryption key ID is required to request a global Taproot presign");
    }
    if (!ikaCoinObjectId || !suiCoinObjectId) {
      throw new Error("Ika and Sui payment coin object IDs are required to request a Taproot presign");
    }

    const tx = new Transaction();
    const ikaTx = this.createIkaTransaction(tx);
    const suiCoin = suiPaymentCoin(tx, suiCoinObjectId);
    const presignSession = ikaTx.requestGlobalPresign({
      dwalletNetworkEncryptionKeyId: networkEncryptionKeyId,
      curve: Curve.SECP256K1,
      signatureAlgorithm: SignatureAlgorithm.Taproot,
      ikaCoin: tx.object(ikaCoinObjectId),
      suiCoin,
    });
    const returnAddress = ikaReturnAddress(this.config.suiPaymentReturnAddress);
    tx.transferObjects([presignSession], tx.pure.address(returnAddress));
    returnSuiPaymentCoinIfNeeded(tx, suiCoinObjectId, suiCoin, returnAddress);

    return buildIkaPtb(this.config.rpcUrl, tx, "Ika global Taproot presign request PTB", this.ikaConfig, [
      ikaCoinObjectId,
      suiCoinObjectId,
    ]);
  }

  async buildTaprootSignWithPublicSharesTransaction(input: {
    dWalletId?: string;
    dWalletCapObjectId?: string;
    presignId: string;
    message: Uint8Array;
    ikaCoinObjectId?: string;
    suiCoinObjectId?: string;
  }): Promise<SuiUnsignedTransaction> {
    const dWalletId = input.dWalletId ?? this.config.dWalletId;
    const dWalletCapObjectId = input.dWalletCapObjectId ?? this.config.dWalletCapObjectId;
    const ikaCoinObjectId = input.ikaCoinObjectId ?? this.config.ikaCoinObjectId;
    const suiCoinObjectId = input.suiCoinObjectId ?? this.config.suiCoinObjectId;
    if (!dWalletId || !dWalletCapObjectId) {
      throw new Error("Ika dWallet ID and dWalletCap object ID are required to request a Taproot signature");
    }
    if (!ikaCoinObjectId || !suiCoinObjectId) {
      throw new Error("Ika and Sui payment coin object IDs are required to request a Taproot signature");
    }
    assert32Bytes(input.message, "Taproot signing message");

    const ikaClient = this.createClient();
    await ikaClient.initialize();
    const [dWallet, presign, encryptedUserSecretKeyShare] = await Promise.all([
      ikaClient.getDWallet(dWalletId),
      ikaClient.getPresign(input.presignId),
      this.config.encryptedUserSecretKeyShareId
        ? ikaClient.getEncryptedUserSecretKeyShare(this.config.encryptedUserSecretKeyShareId)
        : Promise.resolve(undefined),
    ]);

    const tx = new Transaction();
    const ikaTx = this.createIkaTransaction(tx, ikaClient);
    const messageApproval = ikaTx.approveMessage({
      dWalletCap: dWalletCapObjectId,
      curve: Curve.SECP256K1,
      signatureAlgorithm: SignatureAlgorithm.Taproot,
      hashScheme: Hash.SHA256,
      message: input.message,
    });
    const verifiedPresignCap = ikaTx.verifyPresignCap({ presign });
    const suiCoin = suiPaymentCoin(tx, suiCoinObjectId);
    const common = {
      hashScheme: Hash.SHA256,
      verifiedPresignCap,
      presign,
      message: input.message,
      signatureScheme: SignatureAlgorithm.Taproot,
      ikaCoin: tx.object(ikaCoinObjectId),
      suiCoin,
    };

    if (dWallet.kind === "zero-trust") {
      if (!encryptedUserSecretKeyShare) {
        throw new Error("encryptedUserSecretKeyShareId is required for zero-trust Ika signing");
      }
      await ikaTx.requestSign({
        dWallet,
        messageApproval,
        encryptedUserSecretKeyShare,
        ...common,
      });
    } else if (dWallet.kind === "shared") {
      await ikaTx.requestSign({
        dWallet,
        messageApproval,
        ...common,
      });
    } else if (dWallet.kind === "imported-key-shared") {
      const importedKeyMessageApproval = ikaTx.approveImportedKeyMessage({
        dWalletCap: dWalletCapObjectId,
        curve: Curve.SECP256K1,
        signatureAlgorithm: SignatureAlgorithm.Taproot,
        hashScheme: Hash.SHA256,
        message: input.message,
      });
      await ikaTx.requestSignWithImportedKey({
        dWallet,
        importedKeyMessageApproval,
        ...common,
      });
    } else {
      throw new Error(
        `Ika dWallet ${dWalletId} is ${dWallet.kind}; encrypted-share signing requires a user-share integration`,
      );
    }
    returnSuiPaymentCoinIfNeeded(tx, suiCoinObjectId, suiCoin, ikaReturnAddress(this.config.suiPaymentReturnAddress));

    return buildIkaPtb(this.config.rpcUrl, tx, "Ika Taproot sign request PTB", this.ikaConfig, [
      dWalletId,
      dWalletCapObjectId,
      input.presignId,
      ikaCoinObjectId,
      suiCoinObjectId,
    ]);
  }

  private createIkaTransaction(tx: Transaction, ikaClient = this.createClient()): IkaTransaction {
    return new IkaTransaction({
      ikaClient,
      transaction: tx,
      userShareEncryptionKeys: this.config.userShareEncryptionKeys,
    });
  }
}

export function defaultIkaConfig(network: Network = "testnet"): IkaConfig {
  return getNetworkConfig(network);
}

function suiPaymentCoin(tx: Transaction, suiCoinObjectId: string) {
  if (suiCoinObjectId === "__gas__") {
    const amount = BigInt(process.env.UTXOPIA_SUI_IKA_SUI_PAYMENT_NANOS ?? "10000000");
    return tx.splitCoins(tx.gas, [tx.pure.u64(amount)])[0];
  }
  return tx.object(suiCoinObjectId);
}

function returnSuiPaymentCoinIfNeeded(
  tx: Transaction,
  suiCoinObjectId: string,
  suiCoin: ReturnType<typeof suiPaymentCoin>,
  returnAddress?: string,
) {
  if (suiCoinObjectId !== "__gas__") {
    return;
  }
  tx.transferObjects([suiCoin], tx.pure.address(ikaReturnAddress(returnAddress)));
}

function ikaReturnAddress(returnAddress?: string): string {
  const address =
    returnAddress ??
    process.env.UTXOPIA_SUI_RELAYER_ADDRESS ??
    process.env.UTXOPIA_SUI_SIGNER_ADDRESS;
  if (!address) {
    throw new Error("suiPaymentReturnAddress or UTXOPIA_SUI_RELAYER_ADDRESS is required for Ika PTBs");
  }
  return address;
}

async function buildIkaPtb(
  rpcUrl: string,
  tx: Transaction,
  description: string,
  ikaConfig: IkaConfig,
  objectIds: string[],
): Promise<SuiUnsignedTransaction> {
  return {
    chain: "sui",
    kind: "sui-programmable-transaction-block",
    bytes: await tx.build({
      onlyTransactionKind: true,
      client: new SuiJsonRpcClient({ url: rpcUrl, network: "testnet" }),
    }),
    description,
    packageId: ikaConfig.packages.ikaPackage,
    objectIds,
  };
}

function assert32Bytes(value: Uint8Array, label: string) {
  if (value.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
}
