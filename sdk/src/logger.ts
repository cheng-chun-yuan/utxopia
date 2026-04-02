/**
 * Conditional debug logger for AEGIS SDK.
 *
 * Set `AEGIS_DEBUG=1` (Node.js) or `localStorage.aegisDebug = "1"` (browser)
 * to enable debug output. All logs are suppressed by default.
 */

let _enabled: boolean | null = null;

function isEnabled(): boolean {
  if (_enabled !== null) return _enabled;
  try {
    // Node.js
    if (typeof process !== "undefined" && process.env?.AEGIS_DEBUG === "1") {
      _enabled = true;
      return true;
    }
  } catch { /* not Node */ }
  try {
    // Browser
    if (typeof localStorage !== "undefined" && localStorage.getItem("aegisDebug") === "1") {
      _enabled = true;
      return true;
    }
  } catch { /* no localStorage */ }
  _enabled = false;
  return false;
}

export function debug(tag: string, ...args: unknown[]): void {
  if (isEnabled()) console.log(`[aegis:${tag}]`, ...args);
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[aegis:${tag}]`, ...args);
}

/** Force-enable or disable debug logging at runtime */
export function setDebug(enabled: boolean): void {
  _enabled = enabled;
}
