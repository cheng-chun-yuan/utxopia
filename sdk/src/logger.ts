/**
 * Conditional debug logger for PRIVACY_COIN SDK.
 *
 * Set `PRIVACY_COIN_DEBUG=1` (Node.js) or `localStorage.privacyCoinDebug = "1"` (browser)
 * to enable debug output. All logs are suppressed by default.
 */

let _enabled: boolean | null = null;

function isEnabled(): boolean {
  if (_enabled !== null) return _enabled;
  try {
    // Node.js
    if (typeof process !== "undefined" && process.env?.PRIVACY_COIN_DEBUG === "1") {
      _enabled = true;
      return true;
    }
  } catch { /* not Node */ }
  try {
    // Browser
    if (typeof localStorage !== "undefined" && localStorage.getItem("privacyCoinDebug") === "1") {
      _enabled = true;
      return true;
    }
  } catch { /* no localStorage */ }
  _enabled = false;
  return false;
}

export function debug(tag: string, ...args: unknown[]): void {
  if (isEnabled()) console.log(`[pcoin:${tag}]`, ...args);
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[pcoin:${tag}]`, ...args);
}

/** Force-enable or disable debug logging at runtime */
export function setDebug(enabled: boolean): void {
  _enabled = enabled;
}
