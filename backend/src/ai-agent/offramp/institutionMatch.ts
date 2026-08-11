/**
 * Fuzzy matching of a free-text bank / mobile-money name against Paycrest's
 * institution list for a currency. Handles common abbreviations
 * ("GTBank" -> "Guaranty Trust Bank"), acronyms ("UBA" -> "United Bank for
 * Africa"), and typos ("Gauranty Trust" -> "Guaranty Trust Bank").
 */
import type { Institution } from "../../domain/offramp/paycrestAdapter.js";

// Words safe to strip as raw substrings without corrupting other words
// (unlike e.g. "and", which is itself a substring of "Standard").
const SUBSTRING_FILLER = ["microfinance", "financial", "finance", "nigeria", "limited", "bank", "mfb", "plc", "nig", "ltd"];

// Whole-word stopwords ignored when building an institution's acronym.
const ACRONYM_STOPWORDS = new Set(["of", "for", "the", "and", "plc", "limited", "ltd", "nigeria", "nig", "microfinance", "mfb"]);

// Colloquial mobile-money brand names users actually type ("momo", "MTN") that
// don't appear as clean substrings or acronyms of the institution's full name
// (e.g. "MTN Mobile Money Uganda"). Each alias maps to the set of keywords that
// must ALL appear in the institution's raw (filler-preserving) name.
const ALIASES: Record<string, string[]> = {
  momo:         ["mobile", "money"],
  mobilemoney:  ["mobile", "money"],
  mtn:          ["mtn"],
  mtnmomo:      ["mtn"],
  mtnmobilemoney: ["mtn"],
  vodafone:     ["vodafone"],
  voda:         ["vodafone"],
  vodacash:     ["vodafone"],
  telecel:      ["telecel"],
  telecelcash:  ["telecel"],
  airteltigo:   ["airtel", "tigo"],
  airtel:       ["airtel"],
  tigo:         ["tigo"],
  mpesa:        ["mpesa"],
  "m-pesa":     ["mpesa"],
  orange:       ["orange"],
  orangemoney:  ["orange"],
  moov:         ["moov"],
  moovmoney:    ["moov"],
};

// Words that mean "no specific provider named" when that's ALL the query
// contains (e.g. "a bank", "the bank", "mobile money") — as opposed to a
// real but unmatched name, these should never be treated as a failed lookup.
const GENERIC_INSTITUTION_WORDS = new Set([
  "a", "an", "the", "any", "bank", "banks", "account", "provider",
  "mobile", "money",
]);

/** True when `query` names no specific bank/provider at all (just filler words). */
export function isGenericInstitutionQuery(query: string): boolean {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => GENERIC_INSTITUTION_WORDS.has(w));
}

/**
 * Builds the "what's the provider?" question, worded for whatever institution
 * types a corridor actually has (e.g. Nigeria is bank-only, Uganda is mobile-money-only,
 * Kenya has both) instead of always asking about both.
 */
export function describeInstitutionPrompt(institutions: Institution[]): string {
  const types = new Set(institutions.map((i) => i.type));
  const hasBank = types.has("bank");
  const hasMomo = types.has("mobile_money");
  const label =
    hasBank && hasMomo ? "bank or mobile money provider" : hasMomo ? "mobile money provider" : "bank";
  const examples = institutions.slice(0, 3).map((i) => i.name).join(", ");
  return `What's the ${label}?${examples ? ` (e.g. ${examples})` : ""}`;
}

function rawNormalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeForSubstring(name: string): string {
  let out = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const w of [...SUBSTRING_FILLER].sort((a, b) => b.length - a.length)) {
    out = out.split(w).join("");
  }
  return out;
}

function acronymFor(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .filter((w) => w.toLowerCase() === "bank" || !ACRONYM_STOPWORDS.has(w.toLowerCase()))
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j - 1]!, prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Find the best matches for `query` among `institutions`. Tries, in order:
 * EXACT name match, alias, substring (either direction), acronym/
 * abbreviation, then typo-tolerant fuzzy matching. Returns an empty array
 * if nothing is close enough — the caller should fall back to showing the
 * full institution list.
 */
export function findInstitutionMatches(query: string, institutions: Institution[]): Institution[] {
  // Checked first, ahead of every fuzzy strategy below — real bug found
  // live via offrampRoutes' cross-provider institution matching
  // (remittanceDraft.ts): querying Centiiv's much larger 488-bank list
  // with "Access Bank" or "Kuda Microfinance Bank" — both real, exact
  // names in that list — returned 3 and 2 matches respectively (including
  // "Kuda" fuzzy-matching the wholly unrelated "UDA Microfinance Bank"),
  // never reaching a confident single match despite an exact name being
  // right there. An exact (case/whitespace-insensitive) match is
  // unambiguous by construction — no reason to ever let fuzzier logic
  // second-guess it.
  const exactKey = query.trim().toLowerCase();
  const exactMatches = institutions.filter((inst) => inst.name.trim().toLowerCase() === exactKey);
  if (exactMatches.length > 0) return exactMatches;

  const aliasKey = rawNormalize(query);
  const aliasKeywords = ALIASES[aliasKey];
  if (aliasKeywords) {
    const aliasMatches = institutions.filter((inst) => {
      const rawName = rawNormalize(inst.name);
      return aliasKeywords.every((kw) => rawName.includes(kw));
    });
    if (aliasMatches.length > 0) return aliasMatches;
  }

  const qSub = normalizeForSubstring(query);
  if (!qSub) return [];

  if (qSub.length >= 3) {
    const substringMatches = institutions.filter((inst) => {
      const iSub = normalizeForSubstring(inst.name);
      return iSub.length >= 3 && (iSub.includes(qSub) || qSub.includes(iSub));
    });
    if (substringMatches.length > 0) return substringMatches;
  }

  if (qSub.length >= 2) {
    // Exact acronym matches win outright — e.g. "UBA" should resolve to
    // "United Bank for Africa" (UBA) rather than also matching "Union Bank"
    // and "Unity Bank" (both UB) via a weaker prefix match.
    const exactAcronym = institutions.filter((inst) => acronymFor(inst.name).toLowerCase() === qSub);
    if (exactAcronym.length > 0) return exactAcronym;

    const prefixAcronym = institutions.filter((inst) => {
      const iAcr = acronymFor(inst.name).toLowerCase();
      return iAcr.length >= 2 && (iAcr.startsWith(qSub) || qSub.startsWith(iAcr));
    });
    if (prefixAcronym.length > 0) return prefixAcronym;
  }

  if (qSub.length >= 4) {
    const scored = institutions
      .map((inst) => {
        const iSub = normalizeForSubstring(inst.name);
        const dist = levenshtein(qSub, iSub);
        const maxLen = Math.max(qSub.length, iSub.length);
        return { inst, dist, maxLen };
      })
      .filter(({ dist, maxLen }) => dist <= Math.max(1, Math.floor(maxLen * 0.3)));
    if (scored.length > 0) {
      const bestDist = Math.min(...scored.map((s) => s.dist));
      return scored.filter((s) => s.dist === bestDist).map((s) => s.inst);
    }
  }

  return [];
}
