export type CountryInfo = {
  countryCode: string;
  currencyCode: string;
  /** Human display name. */
  name: string;
};

const COUNTRIES: Record<string, CountryInfo> = {
  nigeria: { countryCode: "NG", currencyCode: "NGN", name: "Nigeria" },
  ng:      { countryCode: "NG", currencyCode: "NGN", name: "Nigeria" },
  naira:   { countryCode: "NG", currencyCode: "NGN", name: "Nigeria" },
  kenya:   { countryCode: "KE", currencyCode: "KES", name: "Kenya" },
  ke:      { countryCode: "KE", currencyCode: "KES", name: "Kenya" },
  shilling:{ countryCode: "KE", currencyCode: "KES", name: "Kenya" },
  uganda:  { countryCode: "UG", currencyCode: "UGX", name: "Uganda" },
  ug:      { countryCode: "UG", currencyCode: "UGX", name: "Uganda" },
  tanzania:{ countryCode: "TZ", currencyCode: "TZS", name: "Tanzania" },
  tz:      { countryCode: "TZ", currencyCode: "TZS", name: "Tanzania" },
  malawi:  { countryCode: "MW", currencyCode: "MWK", name: "Malawi" },
  mw:      { countryCode: "MW", currencyCode: "MWK", name: "Malawi" },
  // Real gap found live (2026-09-08) while building the rate-table
  // overview: GHS is genuinely off-ramp-reachable (Centiiv AND Quidax both
  // support it — see their own SUPPORTED_FIAT_CURRENCIES) but had no
  // country entry at all here, so "send $50 to a bank account in Ghana"
  // could never resolve a country despite the corridor actually working.
  ghana:   { countryCode: "GH", currencyCode: "GHS", name: "Ghana" },
  gh:      { countryCode: "GH", currencyCode: "GHS", name: "Ghana" },
  cedi:    { countryCode: "GH", currencyCode: "GHS", name: "Ghana" },
};

// Real gap, same incident as the Ghana entry above: Malawi/MWK is listed
// here as supported but isn't in ANY of the three providers' own
// SUPPORTED_FIAT_CURRENCIES sets (Paycrest: NGN/KES/UGX/TZS, Centiiv:
// NGN/UGX/KES/GHS, Quidax: NGN/GHS) — genuinely unreachable today despite
// this list's claim. Left as-is rather than silently removed (a real
// product decision, not this comment's to make) but flagged here so it's
// not mistaken for verified coverage the way Ghana's absence was.
/** All supported countries, for prompting the user. */
export const SUPPORTED_COUNTRIES = ["Nigeria", "Kenya", "Uganda", "Tanzania", "Ghana", "Malawi"];

/** One CountryInfo per supported currency, for searching across all corridors. */
export function listSupportedCountries(): CountryInfo[] {
  const seen = new Set<string>();
  const out: CountryInfo[] = [];
  for (const c of Object.values(COUNTRIES)) {
    if (seen.has(c.currencyCode)) continue;
    seen.add(c.currencyCode);
    out.push(c);
  }
  return out;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  KES: "KSh",
  UGX: "USh",
  TZS: "TSh",
  MWK: "MK",
  GHS: "₵",
};

/** Display symbol/prefix for a currency code, falling back to the code itself. */
export function getCurrencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode.toUpperCase()] ?? `${currencyCode} `;
}

// Computed, not a hardcoded per-country table — a 2-letter ISO code maps
// directly to its flag by shifting each letter into the Unicode Regional
// Indicator Symbol block (U+1F1E6 = 'A'), which is exactly how flag emoji
// are defined. Correct for any country this file adds later with zero
// extra maintenance, unlike a separately maintained emoji lookup would be.
export function countryCodeToFlag(countryCode: string): string {
  return [...countryCode.toUpperCase()].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join("");
}

/**
 * Resolve a free-text country/currency hint (e.g. "Nigeria", "NGN", "naira")
 * to a country + currency code pair. Returns null if not recognized.
 */
export function resolveCountry(text: string | null | undefined): CountryInfo | null {
  if (!text) return null;
  const key = text.trim().toLowerCase();
  if (COUNTRIES[key]) return COUNTRIES[key];

  // Try matching by currency code directly (e.g. "NGN")
  const byCurrency = Object.values(COUNTRIES).find(
    (c) => c.currencyCode.toLowerCase() === key,
  );
  if (byCurrency) return byCurrency;

  // Try substring match against country names
  const byName = Object.values(COUNTRIES).find((c) =>
    c.name.toLowerCase().includes(key) || key.includes(c.name.toLowerCase()),
  );
  return byName ?? null;
}
