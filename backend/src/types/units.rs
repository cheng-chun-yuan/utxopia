//! Unit Conversion Utilities
//!
//! Helpers for Bitcoin unit conversions and formatting.

/// Satoshis per Bitcoin
pub const SATS_PER_BTC: u64 = 100_000_000;

/// Convert satoshis to BTC string (e.g., "0.00100000")
pub fn sats_to_btc_string(sats: u64) -> String {
    let btc = sats as f64 / SATS_PER_BTC as f64;
    format!("{:.8}", btc)
}

/// Convert satoshis to human-readable string
/// e.g., 100000 -> "100,000 sats (0.001 BTC)"
pub fn sats_to_display(sats: u64) -> String {
    let btc = sats as f64 / SATS_PER_BTC as f64;

    // Format with thousands separator
    let sats_str = format_with_commas(sats);

    format!("{} sats ({:.8} BTC)", sats_str, btc)
}

/// Convert BTC to satoshis
pub fn btc_to_sats(btc: f64) -> u64 {
    (btc * SATS_PER_BTC as f64) as u64
}

/// Format number with thousands separators
fn format_with_commas(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    let chars: Vec<char> = s.chars().collect();

    for (i, c) in chars.iter().enumerate() {
        if i > 0 && (chars.len() - i) % 3 == 0 {
            result.push(',');
        }
        result.push(*c);
    }

    result
}

/// Parse BTC amount from string
pub fn parse_btc(s: &str) -> Option<f64> {
    s.trim().parse().ok()
}

/// Parse satoshi amount from string
pub fn parse_sats(s: &str) -> Option<u64> {
    s.trim()
        .replace(',', "")
        .replace('_', "")
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sats_to_btc() {
        assert_eq!(sats_to_btc_string(0), "0.00000000");
        assert_eq!(sats_to_btc_string(1), "0.00000001");
        assert_eq!(sats_to_btc_string(100_000_000), "1.00000000");
        assert_eq!(sats_to_btc_string(123_456_789), "1.23456789");
    }

    #[test]
    fn test_btc_to_sats() {
        assert_eq!(btc_to_sats(0.0), 0);
        assert_eq!(btc_to_sats(0.00000001), 1);
        assert_eq!(btc_to_sats(1.0), 100_000_000);
        assert_eq!(btc_to_sats(0.5), 50_000_000);
    }

    #[test]
    fn test_display_format() {
        let display = sats_to_display(1_000_000);
        assert!(display.contains("1,000,000"));
        assert!(display.contains("0.01000000 BTC"));
    }

    #[test]
    fn test_parse_sats() {
        assert_eq!(parse_sats("1000"), Some(1000));
        assert_eq!(parse_sats("1,000,000"), Some(1_000_000));
        assert_eq!(parse_sats("1_000_000"), Some(1_000_000));
        assert_eq!(parse_sats("  42  "), Some(42));
        assert_eq!(parse_sats("invalid"), None);
    }
}
