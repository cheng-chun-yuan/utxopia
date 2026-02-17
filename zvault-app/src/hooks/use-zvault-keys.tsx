"use client";

/**
 * @deprecated Use @/hooks/use-zvault instead
 * This file re-exports for backwards compatibility
 */
export { ZVaultProvider, useZVaultKeys } from "./use-zvault";

// Re-export the provider with old name for backwards compatibility
export { ZVaultProvider as ZVaultKeysProvider } from "./use-zvault";
