//! Built-in equivalent-cost price table (M8b).
//!
//! The table ships with the app as a data file (`resources/usage/pricing.json`,
//! also compiled in) and is never downloaded. Only models listed here get an
//! estimate; every other model stays Unknown so unpriced usage is never shown
//! as 0. Entries marked `verified: false` were not confirmed against the
//! vendor price page by the maintainer and are surfaced as such in the UI.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The file is small and parsing it on every load is cheap; it is embedded so a
/// missing or unreadable resource can never silently drop all cost estimates.
const EMBEDDED_PRICING_JSON: &str = include_str!("../../../resources/usage/pricing.json");
const TOKENS_PER_UNIT: f64 = 1_000_000.0;

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct PricingEntry {
    /// Audit metadata from the data file; the pricing tests assert that every
    /// entry carries a label, provider, and source link.
    #[allow(dead_code)]
    #[serde(default)]
    pub label: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub provider: Option<String>,
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub effective_date: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct PricingFile {
    #[serde(default)]
    currency: String,
    #[serde(default)]
    effective_date: Option<String>,
    #[serde(default)]
    models: BTreeMap<String, PricingEntry>,
}

#[derive(Debug, Clone)]
pub(crate) struct PricingEstimate {
    pub amount: f64,
    pub currency: String,
    pub effective_date: Option<String>,
    pub verified: bool,
}

pub(crate) struct PriceTable {
    currency: String,
    effective_date: Option<String>,
    entries: BTreeMap<String, PricingEntry>,
    /// Keys ordered longest-first so a dated model id matches its family entry
    /// before a shorter prefix does.
    prefix_keys: Vec<String>,
}

impl PriceTable {
    /// Loads the first readable table from `candidates`, falling back to the
    /// compiled-in copy. A broken candidate is logged and skipped rather than
    /// silently disabling costs.
    pub(crate) fn load(candidates: &[PathBuf]) -> Self {
        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            match std::fs::read_to_string(candidate) {
                Ok(text) => match Self::from_json(&text) {
                    Ok(table) => return table,
                    Err(error) => log::warn!(
                        "Ignoring unusable usage price table {}: {error}",
                        candidate.display()
                    ),
                },
                Err(error) => log::warn!(
                    "Could not read usage price table {}: {error}",
                    candidate.display()
                ),
            }
        }
        match Self::from_json(EMBEDDED_PRICING_JSON) {
            Ok(table) => table,
            Err(error) => {
                log::error!("Built-in usage price table is unusable: {error}");
                PriceTable::default()
            }
        }
    }

    fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        let file: PricingFile = serde_json::from_str(text)?;
        let currency = if file.currency.trim().is_empty() {
            "USD".to_string()
        } else {
            file.currency.trim().to_string()
        };
        let mut entries = BTreeMap::new();
        for (model, entry) in file.models {
            let key = model.trim().to_ascii_lowercase();
            if key.is_empty() {
                continue;
            }
            entries.insert(key, entry);
        }
        let mut prefix_keys = entries.keys().cloned().collect::<Vec<_>>();
        prefix_keys
            .sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        Ok(Self {
            currency,
            effective_date: file.effective_date,
            entries,
            prefix_keys,
        })
    }

    pub(crate) fn effective_date(&self) -> Option<&str> {
        self.effective_date.as_deref()
    }

    pub(crate) fn currency(&self) -> &str {
        &self.currency
    }

    /// Exact match first, then a family key whose remainder is a release date
    /// (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`). A family key must
    /// not swallow a different model version: `claude-sonnet-4-6` does not
    /// match `claude-sonnet-4`, it stays Unknown until it is added.
    pub(crate) fn entry_for(&self, model: &str) -> Option<&PricingEntry> {
        let normalized = model.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return None;
        }
        if let Some(entry) = self.entries.get(&normalized) {
            return Some(entry);
        }
        self.prefix_keys.iter().find_map(|key| {
            let suffix = normalized.strip_prefix(key.as_str())?;
            if suffix.is_empty() || is_release_date_suffix(suffix) {
                self.entries.get(key)
            } else {
                None
            }
        })
    }

    /// Sums the four token classes at this model's prices. `None` means the
    /// model is not in the table (or prices in a different currency), so the
    /// caller must report Unknown instead of zero.
    pub(crate) fn estimate(
        &self,
        model: &str,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
    ) -> Option<PricingEstimate> {
        let entry = self.entry_for(model)?;
        let entry_currency = entry.currency.as_deref().unwrap_or(&self.currency);
        if !entry_currency.eq_ignore_ascii_case(&self.currency) {
            return None;
        }
        let amount = (input as f64 * entry.input
            + output as f64 * entry.output
            + cache_read as f64 * entry.cache_read
            + cache_write as f64 * entry.cache_write)
            / TOKENS_PER_UNIT;
        Some(PricingEstimate {
            amount,
            currency: self.currency.clone(),
            effective_date: entry
                .effective_date
                .clone()
                .or_else(|| self.effective_date.clone()),
            verified: entry.verified,
        })
    }
}

/// A release-date suffix such as `-20250929` or `-2025-09-29`; anything else
/// after a family key means the id is a different model.
fn is_release_date_suffix(suffix: &str) -> bool {
    let Some(rest) = suffix.strip_prefix('-') else {
        return false;
    };
    if rest.len() == 8 && rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return true;
    }
    let parts = rest.split('-').collect::<Vec<_>>();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
}

impl Default for PriceTable {
    fn default() -> Self {
        Self {
            currency: "USD".to_string(),
            effective_date: None,
            entries: BTreeMap::new(),
            prefix_keys: Vec::new(),
        }
    }
}

/// Resource locations to try before the compiled-in copy: the bundled resource
/// next to the executable, then the repository copy during development.
pub(crate) fn default_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("usage").join("pricing.json"));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("usage")
            .join("pricing.json"),
    );
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> PriceTable {
        PriceTable::from_json(EMBEDDED_PRICING_JSON).expect("built-in price table must parse")
    }

    #[test]
    fn built_in_table_exposes_effective_date_and_entries() {
        let table = table();
        assert_eq!(table.effective_date(), Some("2026-09-22"));
        assert_eq!(table.currency(), "USD");
        assert!(table.entry_for("gpt-5-codex").is_some());
        assert!(table.entry_for("claude-sonnet-4-5").is_some());
    }

    #[test]
    fn dated_claude_model_ids_match_their_family_entry() {
        let table = table();
        let entry = table
            .entry_for("claude-sonnet-4-5-20250929")
            .expect("dated model id");
        assert_eq!(entry.input, 3.0);
        // The family key must win over any shorter accidental prefix.
        let entry = table
            .entry_for("claude-haiku-4-5-20251001")
            .expect("dated haiku id");
        assert_eq!(entry.output, 5.0);
    }

    #[test]
    fn unknown_models_have_no_estimate() {
        let table = table();
        assert!(table.entry_for("claude-unreleased-9").is_none());
        assert!(table.entry_for("codex-auto-review").is_none());
        assert!(table
            .estimate("claude-unreleased-9", 1_000, 1_000, 0, 0)
            .is_none());
        assert!(table
            .estimate("claude-sonnet-4-5-sonnet", 0, 0, 0, 0)
            .is_none());
    }

    #[test]
    fn estimate_uses_all_four_token_classes() {
        let table = table();
        let estimate = table
            .estimate("claude-sonnet-4-5", 1_000_000, 100_000, 2_000_000, 10_000)
            .expect("known model");
        let expected = 3.0 + 1.5 + 0.6 + 0.0375;
        assert!((estimate.amount - expected).abs() < 1e-9, "{estimate:?}");
        assert_eq!(estimate.currency, "USD");
        assert_eq!(estimate.effective_date.as_deref(), Some("2026-09-22"));
        assert!(estimate.verified);
    }

    #[test]
    fn models_in_current_use_carry_verified_vendor_prices() {
        // Checked against the vendor pricing pages on 2026-09-22.
        let table = table();
        for (model, input, output) in [
            ("claude-opus-5", 5.0, 25.0),
            ("claude-sonnet-5", 2.0, 10.0),
            ("gpt-6-astra", 10.0, 50.0),
            ("gpt-5.6-sol", 4.0, 20.0),
            ("gpt-5.6-terra", 2.0, 12.0),
            ("gpt-5.6-luna", 0.2, 1.2),
            ("gpt-5.5", 5.0, 30.0),
        ] {
            let entry = table
                .entry_for(model)
                .unwrap_or_else(|| panic!("{model} priced"));
            assert_eq!((entry.input, entry.output), (input, output), "{model}");
            assert!(entry.verified, "{model} verified");
        }
    }

    #[test]
    fn pricing_entries_carry_a_source_link_and_currency() {
        let table = table();
        for (model, entry) in &table.entries {
            assert!(
                entry
                    .source
                    .as_deref()
                    .is_some_and(|source| !source.is_empty()),
                "{model} must carry a source link"
            );
            assert!(
                entry
                    .currency
                    .as_deref()
                    .is_some_and(|value| !value.is_empty()),
                "{model} must carry a currency"
            );
            assert!(
                entry.effective_date.is_some(),
                "{model} must carry an effective date"
            );
            assert!(entry.label.is_some(), "{model} must carry a label");
            assert!(entry.provider.is_some(), "{model} must name its provider");
        }
    }
}
