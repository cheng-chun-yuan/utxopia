/**
 * Base Deposit Watcher
 *
 * Abstract base class for watching Bitcoin deposits.
 * Platform-specific implementations (Web, React Native) extend this class
 * and provide their own WebSocket and storage implementations.
 */

import { EsploraClient } from "../core/esplora";
import {
  PendingDeposit,
  WatcherCallbacks,
  WatcherConfig,
  StorageAdapter,
  DepositStatus,
  SerializedDeposit,
  serializeDeposit,
  deserializeDeposit,
  generateDepositId,
  DEFAULT_WATCHER_CONFIG,
  MempoolAddressTransaction,
} from "./types";
import { generateNote, initPoseidon } from "../note";
import { deriveTaprootAddress } from "../taproot";
import { createClaimLink } from "../claim-link";
import { bytesToHex, bigintToBytes } from "../crypto";

/**
 * Abstract base class for deposit watching
 *
 * Extend this class and implement:
 * - connectWebSocket()
 * - disconnectWebSocket()
 * - subscribeToAddress(address)
 */
export abstract class BaseDepositWatcher {
  protected deposits: Map<string, PendingDeposit> = new Map();
  protected addressToDepositId: Map<string, string> = new Map();
  protected esplora: EsploraClient;
  protected callbacks: WatcherCallbacks;
  protected storage: StorageAdapter;
  protected config: Required<WatcherConfig>;

  protected confirmationInterval?: ReturnType<typeof setInterval>;
  protected pollingInterval?: ReturnType<typeof setInterval>;
  protected initialized: boolean = false;

  constructor(
    storage: StorageAdapter,
    callbacks: WatcherCallbacks = {},
    config: Partial<WatcherConfig> = {}
  ) {
    this.storage = storage;
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_WATCHER_CONFIG, ...config };
    this.esplora = new EsploraClient(
      this.config.network,
      this.config.esploraUrl
    );
  }

  // =========================================================================
  // Abstract methods - implement in subclass
  // =========================================================================

  /**
   * Connect to WebSocket for real-time transaction notifications
   */
  abstract connectWebSocket(): void;

  /**
   * Disconnect WebSocket
   */
  abstract disconnectWebSocket(): void;

  /**
   * Subscribe to address for transaction notifications
   */
  protected abstract subscribeToAddress(address: string): void;

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Initialize the watcher
   * - Load persisted deposits from storage
   * - Connect WebSocket (if enabled)
   * - Start confirmation checker
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize Poseidon (needed for commitment computation)
    await initPoseidon();

    // Load persisted deposits
    await this.loadFromStorage();

    // Connect WebSocket for real-time updates
    if (this.config.useWebSocket) {
      this.connectWebSocket();
    } else {
      // Fall back to polling
      this.startPolling();
    }

    // Start periodic confirmation checker
    this.startConfirmationChecker();

    this.initialized = true;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.disconnectWebSocket();
    if (this.confirmationInterval) {
      clearInterval(this.confirmationInterval);
      this.confirmationInterval = undefined;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    this.initialized = false;
  }

  // =========================================================================
  // Storage
  // =========================================================================

  protected async loadFromStorage(): Promise<void> {
    const key = `${this.config.storageKeyPrefix}deposits`;
    const data = await this.storage.get(key);

    if (data) {
      try {
        const serialized: SerializedDeposit[] = JSON.parse(data);
        for (const s of serialized) {
          const deposit = deserializeDeposit(s);
          this.deposits.set(deposit.id, deposit);
          this.addressToDepositId.set(deposit.taprootAddress, deposit.id);
        }
      } catch (err) {
        console.error("Failed to load deposits from storage:", err);
      }
    }
  }

  protected async saveToStorage(): Promise<void> {
    const key = `${this.config.storageKeyPrefix}deposits`;
    const serialized = Array.from(this.deposits.values()).map(serializeDeposit);
    await this.storage.set(key, JSON.stringify(serialized));
  }

  // =========================================================================
  // Deposit Management
  // =========================================================================

  /**
   * Create a new deposit to watch
   *
   * @param amount - Amount in satoshis
   * @param baseUrl - Base URL for claim links (optional)
   * @returns The pending deposit with taproot address and claim link
   */
  async createDeposit(amount: bigint, baseUrl?: string): Promise<PendingDeposit> {
    // Generate note with random secrets
    const note = generateNote(amount);

    // For taproot derivation, use XOR of nullifier/secret as placeholder commitment
    // In production, compute actual Poseidon hash via helper circuit or backend
    const placeholderCommitment = bigintToBytes(
      (note.nullifier ^ note.secret) % (2n ** 256n)
    );

    // Derive taproot address from commitment
    const network = this.config.network === "mainnet" ? "mainnet" : "testnet";
    const { address } = await deriveTaprootAddress(placeholderCommitment, network);

    // Create claim link
    const claimLink = createClaimLink(note, baseUrl);

    // Create pending deposit record
    const deposit: PendingDeposit = {
      id: generateDepositId(),
      taprootAddress: address,
      nullifier: bytesToHex(note.nullifierBytes),
      secret: bytesToHex(note.secretBytes),
      amount,
      claimLink,
      status: "waiting",
      confirmations: 0,
      requiredConfirmations: this.config.requiredConfirmations,
      commitment: bytesToHex(placeholderCommitment),
      createdAt: Date.now(),
    };

    // Store and subscribe
    this.deposits.set(deposit.id, deposit);
    this.addressToDepositId.set(deposit.taprootAddress, deposit.id);
    await this.saveToStorage();

    // Subscribe to address for real-time updates
    this.subscribeToAddress(deposit.taprootAddress);

    return deposit;
  }

  /**
   * Watch an existing deposit (from claim link)
   */
  async watchDeposit(deposit: PendingDeposit): Promise<void> {
    this.deposits.set(deposit.id, deposit);
    this.addressToDepositId.set(deposit.taprootAddress, deposit.id);
    await this.saveToStorage();
    this.subscribeToAddress(deposit.taprootAddress);
  }

  /**
   * Get a deposit by ID
   */
  getDeposit(id: string): PendingDeposit | undefined {
    return this.deposits.get(id);
  }

  /**
   * Get a deposit by taproot address
   */
  getDepositByAddress(address: string): PendingDeposit | undefined {
    const id = this.addressToDepositId.get(address);
    return id ? this.deposits.get(id) : undefined;
  }

  /**
   * Get all deposits
   */
  getAllDeposits(): PendingDeposit[] {
    return Array.from(this.deposits.values());
  }

  /**
   * Get deposits by status
   */
  getDepositsByStatus(status: DepositStatus): PendingDeposit[] {
    return this.getAllDeposits().filter((d) => d.status === status);
  }

  /**
   * Remove a deposit from tracking
   */
  async removeDeposit(id: string): Promise<void> {
    const deposit = this.deposits.get(id);
    if (deposit) {
      this.addressToDepositId.delete(deposit.taprootAddress);
      this.deposits.delete(id);
      await this.saveToStorage();
    }
  }

  // =========================================================================
  // Status Updates
  // =========================================================================

  /**
   * Update deposit status with callback notifications
   */
  protected updateStatus(deposit: PendingDeposit, newStatus: DepositStatus): void {
    const oldStatus = deposit.status;
    if (oldStatus === newStatus) return;

    deposit.status = newStatus;

    // Notify status change
    this.callbacks.onStatusChange?.(deposit, oldStatus, newStatus);

    // Notify specific status callbacks
    switch (newStatus) {
      case "detected":
        deposit.detectedAt = Date.now();
        this.callbacks.onDetected?.(deposit);
        break;
      case "confirmed":
        deposit.confirmedAt = Date.now();
        this.callbacks.onConfirmed?.(deposit);
        break;
      case "verified":
        deposit.verifiedAt = Date.now();
        this.callbacks.onVerified?.(deposit);
        break;
      case "claimed":
        deposit.claimedAt = Date.now();
        this.callbacks.onClaimed?.(deposit);
        break;
      case "failed":
        deposit.lastErrorAt = Date.now();
        break;
    }
  }

  /**
   * Mark deposit as having an error
   */
  protected setError(deposit: PendingDeposit, error: Error): void {
    deposit.error = error.message;
    deposit.lastErrorAt = Date.now();
    this.callbacks.onError?.(deposit, error);
  }

  // =========================================================================
  // Transaction Handling
  // =========================================================================

  /**
   * Handle incoming transaction notifications (from WebSocket or polling)
   */
  protected handleTransactions(txs: MempoolAddressTransaction[]): void {
    for (const tx of txs) {
      for (let voutIndex = 0; voutIndex < tx.vout.length; voutIndex++) {
        const vout = tx.vout[voutIndex];
        const address = vout.scriptpubkey_address;

        if (!address) continue;

        const depositId = this.addressToDepositId.get(address);
        if (!depositId) continue;

        const deposit = this.deposits.get(depositId);
        if (!deposit) continue;

        // Skip if already detected
        if (deposit.txid) continue;

        // Update deposit with transaction details
        deposit.txid = tx.txid;
        deposit.vout = voutIndex;
        deposit.detectedAmount = vout.value;

        if (tx.status.confirmed) {
          deposit.blockHeight = tx.status.block_height;
          deposit.blockHash = tx.status.block_hash;
        }

        this.updateStatus(deposit, "detected");
        this.saveToStorage();
      }
    }
  }

  // =========================================================================
  // Confirmation Checking
  // =========================================================================

  protected startConfirmationChecker(): void {
    this.confirmationInterval = setInterval(
      () => this.checkConfirmations(),
      this.config.confirmationPollInterval
    );
  }

  protected async checkConfirmations(): Promise<void> {
    for (const deposit of this.deposits.values()) {
      // Skip deposits that are already confirmed, verified, or claimed
      if (
        deposit.status === "confirmed" ||
        deposit.status === "verified" ||
        deposit.status === "claimed" ||
        deposit.status === "failed"
      ) {
        continue;
      }

      // Skip deposits without a txid
      if (!deposit.txid) continue;

      try {
        const confirmations = await this.esplora.getConfirmations(deposit.txid);
        const previousConfirmations = deposit.confirmations;
        deposit.confirmations = confirmations;

        // Notify on confirmation progress
        if (confirmations > previousConfirmations && confirmations > 0) {
          if (deposit.status !== "confirming") {
            this.updateStatus(deposit, "confirming");
          }
          this.callbacks.onConfirming?.(deposit, confirmations);
        }

        // Check if confirmed
        if (confirmations >= deposit.requiredConfirmations) {
          this.updateStatus(deposit, "confirmed");
          await this.saveToStorage();

          // Auto-verify on Solana if enabled
          if (this.config.autoVerify) {
            // Note: Actual verification requires Solana connection
            // This will be handled by the React hook or user code
          }
        }
      } catch (err) {
        console.error(`Failed to check confirmations for ${deposit.txid}:`, err);
      }
    }
  }

  // =========================================================================
  // Polling (fallback when WebSocket not available)
  // =========================================================================

  protected startPolling(): void {
    this.pollingInterval = setInterval(
      () => this.pollAddresses(),
      this.config.pollingInterval
    );
  }

  protected async pollAddresses(): Promise<void> {
    for (const deposit of this.deposits.values()) {
      // Only poll for waiting or detected deposits
      if (deposit.status !== "waiting" && deposit.status !== "detected") {
        continue;
      }

      try {
        // Check mempool first
        const mempoolTxs = await this.esplora.getAddressTxs(
          deposit.taprootAddress
        );

        if (mempoolTxs.length > 0) {
          // Convert to our format and handle
          const converted: MempoolAddressTransaction[] = mempoolTxs.map(
            (tx) => ({
              txid: tx.txid,
              version: tx.version,
              locktime: tx.locktime,
              vin: tx.vin.map((vin) => ({
                txid: vin.txid,
                vout: vin.vout,
                prevout: vin.prevout
                  ? {
                      scriptpubkey: vin.prevout.scriptpubkey,
                      scriptpubkey_asm: vin.prevout.scriptpubkey_asm,
                      scriptpubkey_type: vin.prevout.scriptpubkey_type,
                      scriptpubkey_address: vin.prevout.scriptpubkey_address,
                      value: vin.prevout.value,
                    }
                  : null,
                scriptsig: vin.scriptsig,
                scriptsig_asm: vin.scriptsig_asm,
                witness: vin.witness,
                is_coinbase: vin.is_coinbase,
                sequence: vin.sequence,
              })),
              vout: tx.vout.map((vout) => ({
                scriptpubkey: vout.scriptpubkey,
                scriptpubkey_asm: vout.scriptpubkey_asm,
                scriptpubkey_type: vout.scriptpubkey_type,
                scriptpubkey_address: vout.scriptpubkey_address,
                value: vout.value,
              })),
              size: tx.size,
              weight: tx.weight,
              fee: tx.fee,
              status: tx.status,
            })
          );

          this.handleTransactions(converted);
        }
      } catch (err) {
        console.error(
          `Failed to poll address ${deposit.taprootAddress}:`,
          err
        );
      }
    }
  }

  // =========================================================================
  // Manual operations
  // =========================================================================

  /**
   * Manually mark a deposit as verified (called after Solana verification)
   */
  async markVerified(id: string, leafIndex: number): Promise<void> {
    const deposit = this.deposits.get(id);
    if (deposit) {
      deposit.leafIndex = leafIndex;
      this.updateStatus(deposit, "verified");
      await this.saveToStorage();
    }
  }

  /**
   * Manually mark a deposit as claimed
   */
  async markClaimed(id: string): Promise<void> {
    const deposit = this.deposits.get(id);
    if (deposit) {
      this.updateStatus(deposit, "claimed");
      await this.saveToStorage();
    }
  }

  /**
   * Force refresh a deposit's status from the blockchain
   */
  async refreshDeposit(id: string): Promise<PendingDeposit | undefined> {
    const deposit = this.deposits.get(id);
    if (!deposit) return undefined;

    try {
      // Check for transactions
      const txs = await this.esplora.getAddressTxs(deposit.taprootAddress);

      if (txs.length > 0 && !deposit.txid) {
        // Find matching output
        for (const tx of txs) {
          for (let i = 0; i < tx.vout.length; i++) {
            if (tx.vout[i].scriptpubkey_address === deposit.taprootAddress) {
              deposit.txid = tx.txid;
              deposit.vout = i;
              deposit.detectedAmount = tx.vout[i].value;

              if (tx.status.confirmed) {
                deposit.blockHeight = tx.status.block_height;
                deposit.blockHash = tx.status.block_hash;
              }

              this.updateStatus(deposit, "detected");
              break;
            }
          }
          if (deposit.txid) break;
        }
      }

      // Update confirmations
      if (deposit.txid) {
        deposit.confirmations = await this.esplora.getConfirmations(
          deposit.txid
        );

        if (deposit.confirmations >= deposit.requiredConfirmations) {
          if (deposit.status !== "confirmed" && deposit.status !== "verified" && deposit.status !== "claimed") {
            this.updateStatus(deposit, "confirmed");
          }
        } else if (deposit.confirmations > 0) {
          if (deposit.status !== "confirming") {
            this.updateStatus(deposit, "confirming");
          }
        }
      }

      await this.saveToStorage();
      return deposit;
    } catch (err) {
      console.error(`Failed to refresh deposit ${id}:`, err);
      return deposit;
    }
  }
}
