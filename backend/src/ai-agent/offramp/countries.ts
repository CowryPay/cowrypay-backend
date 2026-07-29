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
};

/** All supported countries, for prompting the user. */
export const SUPPORTED_COUNTRIES = ["Nigeria", "Kenya", "Uganda", "Tanzania", "Malawi"];

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
};

/** Display symbol/prefix for a currency code, falling back to the code itself. */
export function getCurrencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOLS[currencyCode.toUpperCase()] ?? `${currencyCode} `;
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
