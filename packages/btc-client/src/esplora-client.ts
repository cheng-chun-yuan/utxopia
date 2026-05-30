import type {
  BitcoinAddressInfo,
  BitcoinClient,
  BitcoinDepositCandidate,
  BitcoinMerkleProof,
  BitcoinNetwork,
  BitcoinOutspend,
  BitcoinTransaction,
  BitcoinTxStatus,
  BitcoinUtxo,
} from "./types";
import { extractUtxopiaDepositOpReturn } from "./op-return";

const NETWORK_URLS: Record<BitcoinNetwork, string> = {
  mainnet: "https://mempool.space/api",
  testnet: "https://mempool.space/testnet/api",
  testnet4: "https://mempool.space/testnet4/api",
  signet: "https://mempool.space/signet/api",
  regtest: "http://localhost:2140",
};

export interface EsploraClientOptions {
  network?: BitcoinNetwork;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class EsploraBitcoinClient implements BitcoinClient {
  readonly network: BitcoinNetwork;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EsploraClientOptions = {}) {
    this.network = options.network ?? "testnet";
    this.baseUrl = (options.baseUrl ?? NETWORK_URLS[this.network]).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getAddress(address: string): Promise<BitcoinAddressInfo> {
    return this.getJson(`/address/${address}`);
  }

  async getAddressTxs(address: string, lastSeenTxid?: string): Promise<BitcoinTransaction[]> {
    return this.getJson(lastSeenTxid ? `/address/${address}/txs/chain/${lastSeenTxid}` : `/address/${address}/txs`);
  }

  async getAddressTxsMempool(address: string): Promise<BitcoinTransaction[]> {
    return this.getJson(`/address/${address}/txs/mempool`);
  }

  async getAddressUtxos(address: string): Promise<BitcoinUtxo[]> {
    return this.getJson(`/address/${address}/utxo`);
  }

  async getTransaction(txid: string): Promise<BitcoinTransaction> {
    return this.getJson(`/tx/${txid}`);
  }

  async getTxStatus(txid: string): Promise<BitcoinTxStatus> {
    return this.getJson(`/tx/${txid}/status`);
  }

  async getTxHex(txid: string): Promise<string> {
    return this.getText(`/tx/${txid}/hex`);
  }

  async getTxMerkleProof(txid: string): Promise<BitcoinMerkleProof> {
    return this.getJson(`/tx/${txid}/merkle-proof`);
  }

  async getTxOutspend(txid: string, vout: number): Promise<BitcoinOutspend> {
    return this.getJson(`/tx/${txid}/outspend/${vout}`);
  }

  async getBlockHeight(): Promise<number> {
    return Number.parseInt(await this.getText("/blocks/tip/height"), 10);
  }

  async getBlockHash(height: number): Promise<string> {
    return this.getText(`/block-height/${height}`);
  }

  async getBlockHeader(hash: string): Promise<string> {
    return this.getText(`/block/${hash}/header`);
  }

  async broadcastTx(txHex: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/tx`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: txHex,
    });
    if (!res.ok) {
      throw new Error(`Esplora broadcast failed: ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return res.text();
  }

  async getConfirmations(txid: string): Promise<number> {
    const status = await this.getTxStatus(txid);
    if (!status.confirmed || status.block_height === undefined) {
      return 0;
    }

    const tipHeight = await this.getBlockHeight();
    return tipHeight - status.block_height + 1;
  }

  async findDepositCandidates(address: string, minConfirmations = 1): Promise<BitcoinDepositCandidate[]> {
    const [utxos, tipHeight, txs] = await Promise.all([
      this.getAddressUtxos(address),
      this.getBlockHeight(),
      this.getAddressTxs(address),
    ]);
    const txById = new Map(txs.map((tx) => [tx.txid, tx]));

    return utxos
      .map((utxo) => ({
        address,
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        confirmations: confirmationsForStatus(utxo.status, tipHeight),
        status: utxo.status,
        opReturn: extractUtxopiaDepositOpReturn(txById.get(utxo.txid)),
      }))
      .filter((candidate) => candidate.confirmations >= minConfirmations);
  }

  private async getJson<T>(endpoint: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`);
    if (!res.ok) {
      throw new Error(`Esplora API failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  private async getText(endpoint: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${endpoint}`);
    if (!res.ok) {
      throw new Error(`Esplora API failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }
}

function confirmationsForStatus(status: BitcoinTxStatus, tipHeight: number): number {
  if (!status.confirmed || status.block_height === undefined) {
    return 0;
  }

  return tipHeight - status.block_height + 1;
}
