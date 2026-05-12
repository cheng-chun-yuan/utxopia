// Zustand stores - import directly, no providers needed
export {
  useBitcoinWalletStore,
  useBitcoinWallet,
  type BitcoinWalletState,
  type BtcWalletType,
} from "./bitcoin-wallet-store";

export {
  useUTXOpiaStore,
  useUTXOpia,
  useUTXOpiaKeys,
  useStealthInbox,
  type InboxNote,
} from "./utxopia-store";

export {
  useNotesStore,
  useNoteStorage,
  type StoredNote,
} from "./notes-store";

// Hydration component
export { StoreHydration } from "./StoreHydration";
