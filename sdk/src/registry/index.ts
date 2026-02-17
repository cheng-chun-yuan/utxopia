/**
 * Name Registry (.zkey.sol) Subpath
 *
 * Human-readable stealth address names for ZVault.
 */

export {
  // Lookup functions
  lookupZkeyName,
  lookupZkeyNameWithPDA,
  parseNameRegistry,
  // Reverse lookup (SNS pattern)
  reverseLookupZkeyName,
  deriveReverseRegistryPDA,
  parseReverseRegistry,
  // Validation
  isValidName,
  normalizeName,
  formatZkeyName,
  getNameValidationError,
  hashName,
  // Instruction builders
  buildRegisterNameData,
  buildUpdateNameData,
  buildTransferNameData,
  // Constants
  MAX_NAME_LENGTH,
  NAME_REGISTRY_SEED,
  REVERSE_REGISTRY_SEED,
  NAME_REGISTRY_DISCRIMINATOR,
  REVERSE_REGISTRY_DISCRIMINATOR,
  NAME_REGISTRY_SIZE,
  REVERSE_REGISTRY_SIZE,
  // Types
  type NameRegistryEntry,
  type ZkeyStealthAddress,
} from "../name-registry";
