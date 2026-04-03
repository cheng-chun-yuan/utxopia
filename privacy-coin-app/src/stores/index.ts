// Zustand stores - import directly, no providers needed
export {
  useBitcoinWalletStore,
  useBitcoinWallet,
  type BitcoinWalletState,
  type BtcWalletType,
} from "./bitcoin-wallet-store";

export {
  usePrivacyCoinStore,
  usePrivacyCoin,
  usePrivacyCoinKeys,
  useStealthInbox,
  type InboxNote,
} from "./privacy-coin-store";

export {
  useNotesStore,
  useNoteStorage,
  type StoredNote,
} from "./notes-store";

// Hydration component
export { StoreHydration } from "./StoreHydration";
