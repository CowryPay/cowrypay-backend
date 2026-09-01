import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { lockedOrdersRepo } from "../offramp/lockedOrdersRepository.js";
import {
  getCurrencySymbol,
  listSupportedCountries,
  resolveCountry,
  SUPPORTED_COUNTRIES,
  type CountryInfo,
} from "../../ai-agent/offramp/countries.js";
import { describeInstitutionPrompt, findInstitutionMatches } from "../../ai-agent/offramp/institutionMatch.js";
import {
  createOfframpOrder,
  getInstitutions,
  verifyRecipientAccount,
  NoLiquidityProviderError,
  type Institution,
  type CreatedOrder,
} from "../offramp/paycrestAdapter.js";
import { getInstitutions as getQuidaxInstitutions, createOfframpOrder as createQuidaxOrder } from "../offramp/quidaxAdapter.js";
import {
  getInstitutions as getCentiivInstitutions,
  createOfframpOrder as createCentiivOrder,
  centiivBeneficiaryTypeFor,
  centiivMobileMoneyNetworkFor,
} from "../offramp/centiivAdapter.js";
import {
  selectOfframpProvider,
  isQuidaxEligible,
  isCentiivEligible,
  isPaycrestEligible,
  explainNoProviderMessage,
  type OfframpProvider,
} from "../offramp/providerSelection.js";
import { computeFeeSplit, requireTreasuryAddress } from "../offramp/fee.js";
import { getTokenConfig, SUPPORTED_CHAINS as EVM_CHAINS } from "../wallets/chains.js";
import { recipientsRepo } from "../recipients/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { formatAmount } from "../../utils/format.js";
import type { SendRecipient } from "../../types.js";
import type { ParsedIntent } from "./schemas.js";
import { resolveInstitutionWithLlm } from "./llm.js";

export interface RemittanceDraft {
  amount: string;
  feeAmount: string;
  netAmount: string;
  treasuryAddress: string;
  fiatCurrency: string;
  recipient: SendRecipient;
  rate: string;
  reference: string;
  orderId: string;
  receiveAddress: string;
  validUntil: string;
  chain: string;
  // Which provider actually locked this rate — POST /offramp/sends' reuse
  // path needs this (see service.ts's LockedOrder), and the frontend should
  // show it somewhere (confirm card / receipt) per Roberto's own note on
  // why this field exists.
  provider: OfframpProvider;
  // Which token this order was actually quoted/created for — see
  // service.ts's LockedOrder.tokenSymbol comment.
  tokenSymbol: string;
}

export type RemittanceResolution =
  | { ok: true; draft: RemittanceDraft; summary: string }
  | { ok: false; message: string };

export type RemittanceIntent = Extract<ParsedIntent, { kind: "remittance" }>;

// Fills gaps in a newly-parsed message with whatever the prior draft already
// had — new non-empty values win, missing ones fall back to what's already
// known. Doesn't trust the LLM to always echo prior fields back itself.
// accountIdentifier is NOT carried forward unconditionally when the
// institution or country actually changes — same incident class as
// crossChainSendDraft.ts's mergeCrossChainSendDrafts (see its own
// comment): a draft stuck alive for days (touchSession refreshes the idle
// timer on any later message without clearing an unresolved draft) could
// otherwise silently reuse a bank account number meant for a different
// institution/country once the user names a new one without repeating
// the account number.
export function mergeRemittanceDrafts(existing: RemittanceIntent, incoming: RemittanceIntent): RemittanceIntent {
  const institutionChanged =
    incoming.institutionHint != null &&
    existing.institutionHint != null &&
    incoming.institutionHint.toLowerCase() !== existing.institutionHint.toLowerCase();
  const countryChanged =
    incoming.countryHint != null && existing.countryHint != null && incoming.countryHint.toLowerCase() !== existing.countryHint.toLowerCase();
  const contextChanged = institutionChanged || countryChanged;
  return {
    kind: "remittance",
    action: "SEND_REMITTANCE",
    amount: incoming.amount ?? existing.amount,
    recipientNickname: incoming.recipientNickname ?? existing.recipientNickname,
    countryHint: incoming.countryHint ?? existing.countryHint,
    institutionHint: incoming.institutionHint ?? existing.institutionHint,
    accountIdentifier: incoming.accountIdentifier ?? (contextChanged ? undefined : existing.accountIdentifier),
    chainHint: incoming.chainHint ?? existing.chainHint,
    tokenHint: incoming.tokenHint ?? existing.tokenHint,
  };
}

/**
 * Some institutions only operate in one country (e.g. "OPay" -> Nigeria
 * only). When the user names a specific provider before naming a country,
 * search every supported corridor's institution list and, if the name
 * resolves to exactly one country, infer the country instead of asking for
 * it. Falls back to null (caller asks the country question as usual) if
 * it's ambiguous, unmatched, or a lookup fails.
 */
async function resolveInstitutionAcrossCountries(
  query: string,
): Promise<{ country: CountryInfo; institution: Institution } | null> {
  const countries = listSupportedCountries();
  const results = await Promise.all(
    countries.map(async (country) => {
      try {
        const institutions = await getInstitutions(country.currencyCode);
        const matches = findInstitutionMatches(query, institutions);
        if (matches.length === 1) return { country, institution: matches[0]! };
      } catch {
        // Ignore per-corridor lookup failures — worst case we miss an inference.
      }
      return null;
    }),
  );
  const hits = results.filter((r): r is { country: CountryInfo; institution: Institution } => r !== null);
  return hits.length === 1 ? hits[0]! : null;
}

// Shared tail once amount + fiatCurrency + a fully-resolved recipient are
// known, whether that came from a fresh parse or a saved recipient. Locks a
// real rate by creating a Paycrest order (see resolveRemittanceIntent's own
// comment for why that's the source of truth instead of the rate-preview
// endpoint) and only sends the net amount (after platform fee) for
// conversion — the fee itself isn't moved anywhere yet, just recorded.
async function finalizeRemittanceDraft(
  userId: string,
  amount: number,
  fiatCurrency: string,
  fiatCountryLabel: string,
  recipient: SendRecipient,
  chainHint?: string,
  tokenHint?: string,
): Promise<RemittanceResolution> {
  const wallet = await walletsRepo.findByUserIdAndChain(userId, env.defaultChain);
  if (!wallet) return { ok: false, message: `I couldn't find your wallet — try again in a moment.` };
  const walletAddress = wallet.address;

  // Omitted means USDC, the only token that existed before USDT support.
  const tokenSymbol = tokenHint?.toUpperCase() ?? env.defaultTokenSymbol;

  // Balance is tracked per chain (a token on one chain isn't spendable on
  // another) — resolve which chain this send draws from before locking a
  // rate. No balance anywhere yet still falls through to wallet.chain as a
  // reasonable default; the real "not enough funds" error surfaces later,
  // atomically, at actual debit time (domain/offramp/service.ts) — this is
  // only about which chain, not whether there's enough there.
  // A balance row's chain can be null on the shared database in its
  // current (temporarily reverted, post-incident) state — normalized to
  // wallet.chain here so nothing downstream has to guard against it
  // individually (a real null previously crashed the chainHint match below).
  const balances = await ledgerRepo.getBalancesForUser(userId);
  const fundedChains = balances
    .filter((b) => b.tokenSymbol === tokenSymbol && Number(b.availableBalance) > 0)
    .map((b) => ({ ...b, chain: b.chain ?? wallet.chain }));

  let chain: string;
  if (chainHint) {
    const match = fundedChains.find((b) => b.chain.toLowerCase() === chainHint.toLowerCase());
    if (!match) {
      return {
        ok: false,
        message: `You don't have a ${tokenSymbol} balance on ${chainHint} to send from.`,
      };
    }
    chain = match.chain;
  } else if (fundedChains.length > 1) {
    const list = fundedChains.map((b) => `${b.chain} (${formatAmount(b.availableBalance)} ${tokenSymbol})`).join(", ");
    return { ok: false, message: `Which chain would you like to send from? You have balance on: ${list}.` };
  } else {
    chain = fundedChains[0]?.chain ?? wallet.chain;
  }

  // EVM chains validate token support via chains.ts's token map (e.g. USDT
  // on Base isn't configured) — only reachable here via the zero-balance
  // fallback-to-wallet.chain path above, since a funded balance can't exist
  // for a token/chain pair chains.ts never enabled in the first place.
  // Stellar/Solana are already covered by the fundedChains check itself.
  // Sourced from chains.ts's own registry (EVM_CHAINS), not a separately
  // maintained literal list — real bug class this avoids: adding a new
  // EVM chain to chains.ts without remembering to update every one of the
  // several other hardcoded ["celo","base","optimism"] copies that used
  // to exist across this codebase.
  if (EVM_CHAINS.includes(chain.toLowerCase())) {
    try {
      getTokenConfig(chain, tokenSymbol);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Moved here (after chain is known) rather than resolved eagerly at the
  // top of this function — requireTreasuryAddress is chain-aware now (see
  // fee.ts's own comment on why: Stellar/Solana each need their own real
  // treasury address, not the single EVM one).
  let treasuryAddress: string;
  try {
    treasuryAddress = await requireTreasuryAddress(chain);
  } catch (err) {
    return { ok: false, message: `Sends aren't available right now (${err instanceof Error ? err.message : String(err)}).` };
  }

  const amountStr = String(amount);
  const { feeAmount, netAmount } = computeFeeSplit(amountStr);
  const reference = randomUUID();

  // Quidax is only ever used here if the SAME bank can be confidently
  // found on its own institution list — recipient.institution above was
  // already resolved as a Paycrest bank code, and each provider's bank
  // codes are a different namespace for the same real-world bank. Reusing
  // Paycrest's code on a Quidax/Centiiv order (or vice versa) would
  // silently misroute the payout, so this only switches provider when a
  // single, unambiguous name match exists on THAT provider's own list;
  // any other outcome (not eligible, no match, lookup failure) falls
  // straight back to Paycrest, unchanged from before either existed.
  let provider: OfframpProvider = "paycrest";
  // Starts as the original (Paycrest-coded) recipient; only ever replaced
  // with an alt-provider-coded version once a confident single match is
  // found — this is what actually gets sent to whichever provider AND
  // stored on the resulting `send` row, so it must never end up mixing
  // one provider's institution code with another's order.
  let finalRecipient: SendRecipient = recipient;
  let altRecipient: { institution: string; accountIdentifier: string; accountName: string; network?: string } | null =
    null;

  if (isQuidaxEligible(chain, fiatCurrency) || isCentiivEligible(chain, fiatCurrency)) {
    try {
      const selection = await selectOfframpProvider({ chain, token: tokenSymbol, amount: netAmount, fiatCurrency });
      console.log(`[remittance-draft] provider selection for ${chain}: ${selection.provider} (toAmount=${selection.toAmount})`);
      if (selection.provider === "quidax") {
        const altInstitutions = await getQuidaxInstitutions(fiatCurrency);
        const searchTerm = recipient.institutionName ?? recipient.institution;
        const matches = findInstitutionMatches(searchTerm, altInstitutions);
        if (matches.length === 1) {
          const matched = matches[0]!;
          provider = selection.provider;
          finalRecipient = { ...recipient, institution: matched.code, institutionName: matched.name };
          altRecipient = {
            institution: matched.code,
            accountIdentifier: recipient.accountIdentifier,
            accountName: recipient.accountName,
          };
        } else {
          // Logged loudly, not silently — this is exactly the kind of gap
          // that produced a confusing "not available" message with zero
          // diagnostic trail the first time this was reported.
          console.log(
            `[remittance-draft] ${selection.provider} won the rate for ${chain} but institution cross-match found ${matches.length} matches for "${searchTerm}" (need exactly 1) — falling back to paycrest, which isn't eligible for ${chain} either.`,
          );
        }
      } else if (selection.provider === "centiiv") {
        const beneficiaryType = centiivBeneficiaryTypeFor(fiatCurrency);
        if (beneficiaryType === "BANK") {
          // NGN — same institution-code cross-match as Quidax above.
          const altInstitutions = await getCentiivInstitutions();
          const searchTerm = recipient.institutionName ?? recipient.institution;
          const matches = findInstitutionMatches(searchTerm, altInstitutions);
          if (matches.length === 1) {
            const matched = matches[0]!;
            provider = selection.provider;
            finalRecipient = { ...recipient, institution: matched.code, institutionName: matched.name };
            altRecipient = {
              institution: matched.code,
              accountIdentifier: recipient.accountIdentifier,
              accountName: recipient.accountName,
            };
          } else {
            console.log(
              `[remittance-draft] centiiv won the rate for ${chain} but institution cross-match found ${matches.length} matches for "${searchTerm}" (need exactly 1) — falling back to paycrest, which isn't eligible for ${chain} either.`,
            );
          }
        } else if (beneficiaryType === "MOBILEMONEY") {
          // UGX/KES/GHS — there's no institution list to cross-match
          // against at all (Centiiv's /banking/banks is NGN bank codes
          // only); the "institution" here is really a carrier network, a
          // small fixed enum resolved directly from what the user already
          // named (see centiivMobileMoneyNetworkFor's own comment on why
          // this differs from the BANK cross-match above).
          const searchTerm = recipient.institutionName ?? recipient.institution;
          const network = centiivMobileMoneyNetworkFor(fiatCurrency, searchTerm);
          if (network) {
            provider = selection.provider;
            finalRecipient = { ...recipient, institution: network, institutionName: network };
            altRecipient = {
              institution: network,
              accountIdentifier: recipient.accountIdentifier,
              accountName: recipient.accountName,
              network,
            };
          } else {
            console.log(
              `[remittance-draft] centiiv won the rate for ${chain} but couldn't resolve a mobile money network for ${fiatCurrency} from "${searchTerm}" — falling back to paycrest, which isn't eligible for ${chain} either.`,
            );
          }
        }
      }
    } catch (err) {
      // Alt provider unavailable this round (rate lookup or institution
      // list failed) — fall back to Paycrest below, same as always.
      console.log(`[remittance-draft] alt provider lookup failed for ${chain}:`, err instanceof Error ? err.message : err);
    }
  }

  // Real gap this closes: `provider` defaults to "paycrest" whenever no
  // alt provider won OR the winning alt provider's bank couldn't be
  // confidently cross-matched — but for a chain Paycrest doesn't support
  // at all (Optimism/Solana/Stellar, see paycrestAdapter.ts), that default
  // was never actually valid, and createOrderForProvider below would have
  // attempted it anyway and failed with Paycrest's own confusing raw
  // error, before the fallback-retry logic even got a chance to run
  // (that logic only handles the CHOSEN provider's order creation
  // failing, not "the default was never valid to begin with").
  if (provider === "paycrest" && !isPaycrestEligible(chain, fiatCurrency)) {
    console.log(`[remittance-draft] no eligible provider for ${chain}/${fiatCurrency} after selection — defaulted to paycrest, which isn't eligible.`);
    return { ok: false, message: explainNoProviderMessage(chain, fiatCurrency) };
  }

  async function createOrderForProvider(p: OfframpProvider): Promise<CreatedOrder> {
    if (p === "quidax" && altRecipient) {
      return createQuidaxOrder({ amount: netAmount, network: chain, token: tokenSymbol, fiatCurrency, recipient: altRecipient, reference });
    }
    if (p === "centiiv" && altRecipient) {
      return createCentiivOrder({ amount: netAmount, network: chain, token: tokenSymbol, fiatCurrency, recipient: altRecipient, reference });
    }
    return createOfframpOrder({
      amount: netAmount,
      token: tokenSymbol,
      network: chain,
      refundAddress: walletAddress,
      fiatCurrency,
      recipient,
      reference,
    });
  }

  let order;
  try {
    order = await createOrderForProvider(provider);
  } catch (err) {
    // The chosen alt provider's order creation itself failed (e.g. a
    // name-match rejection at Quidax's bank-account-attach step, or
    // Centiiv's own live bank-account verification) — the user can still
    // send via Paycrest, so retry there once before actually giving up.
    // BUT only if Paycrest actually supports this chain at all — verified
    // live that it structurally doesn't for Optimism/Solana/Stellar (a
    // hard "not supported" error, not a liquidity gap), so blindly
    // retrying there for e.g. a Stellar send just produced Paycrest's own
    // confusing raw validation error instead of an honest message.
    if (provider !== "paycrest" && isPaycrestEligible(chain, fiatCurrency)) {
      try {
        provider = "paycrest";
        finalRecipient = recipient; // undo the alt-provider-coded recipient, back to Paycrest's own coding
        order = await createOrderForProvider("paycrest");
      } catch (fallbackErr) {
        if (fallbackErr instanceof NoLiquidityProviderError) {
          return { ok: false, message: fallbackErr.message };
        }
        return {
          ok: false,
          message: `Couldn't lock a rate for that right now (${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}). Try again in a moment.`,
        };
      }
    } else if (err instanceof NoLiquidityProviderError) {
      return { ok: false, message: err.message };
    } else if (provider !== "paycrest") {
      // The alt provider failed and Paycrest was never a real option for
      // this chain — an honest, non-technical message instead of either
      // provider's raw error text. Deliberately NOT explainNoProviderMessage
      // here: that's for "this chain/currency combo has no eligible
      // provider at all" (a structural fact, checked before any order was
      // attempted); this is a real order ATTEMPT that failed at the
      // eligible provider (e.g. a bank-account verification rejection) —
      // saying "isn't supported" would be actively wrong when it may well
      // succeed on a retry. Logged loudly since this message alone gives
      // no diagnostic trail otherwise.
      console.log(
        `[remittance-draft] ${provider} order creation failed for ${chain}, no fallback available:`,
        err instanceof Error ? err.message : err,
      );
      return {
        ok: false,
        message: `We couldn't complete this transfer right now — please try again in a moment.`,
      };
    } else {
      return {
        ok: false,
        message: `Couldn't lock a rate for that right now (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`,
      };
    }
  }

  const payout = Number(netAmount) * Number(order.rate);
  const payoutEstimate = Number.isFinite(payout)
    ? ` (roughly ${getCurrencySymbol(fiatCurrency)}${payout.toLocaleString()})`
    : "";

  // Persisted so initiateSend can look this exact order up by reference
  // instead of trusting whatever the client echoes back in existingOrder —
  // see lockedOrdersRepository.ts's own comment for the vulnerability this
  // closes. Best-effort in the sense that a failure here shouldn't block
  // the user from seeing their quote, but it's the only thing that makes
  // POST /offramp/sends's reuse path safe, so it's logged loudly (not
  // silently swallowed) if it ever fails.
  try {
    await lockedOrdersRepo.create(pool, {
      reference,
      userId,
      chain,
      tokenSymbol,
      fiatCurrency,
      amountHuman: amountStr,
      feeAmount,
      treasuryAddress,
      provider,
      providerOrderId: order.orderId,
      receiveAddress: order.receiveAddress,
      rate: order.rate,
      recipient: finalRecipient,
      validUntil: order.validUntil,
    });
  } catch (err) {
    console.error(`[remittance-draft] failed to persist locked order for reference ${reference}:`, err);
  }

  return {
    ok: true,
    draft: {
      amount: amountStr,
      feeAmount,
      netAmount,
      treasuryAddress,
      fiatCurrency,
      recipient: finalRecipient,
      rate: order.rate,
      reference,
      orderId: order.orderId,
      receiveAddress: order.receiveAddress,
      validUntil: order.validUntil,
      chain,
      provider,
      tokenSymbol,
    },
    summary: `Ready to send $${amountStr} to ${recipient.accountName}${fiatCountryLabel}${payoutEstimate}. Fee: ${feeAmount} ${tokenSymbol}. This quote is locked for about an hour — confirm in the app to enter your PIN and complete it.`,
  };
}

// Turns a parsed remittance intent into either a fully-resolved, ready-to-send
// draft, or a conversational question asking for whatever's missing/ambiguous.
//
// Gets its rate by actually creating a real Paycrest order, not by previewing
// one — Paycrest's GET /rates estimate endpoint doesn't cover every network
// (Celo included) even when real payout liquidity exists there, so relying
// on it produces false "no provider available" errors. Creating the order up
// front doesn't move any funds itself (only the still-unbuilt Blockradar
// withdraw step does that, gated behind PIN) — it just locks a real rate and
// receive address, which POST /offramp/sends reuses on confirm instead of
// creating a second, redundant order. This never calls initiateSend itself:
// chat only ever gets to *propose*, never to *execute*.
export async function resolveRemittanceIntent(
  userId: string,
  intent: RemittanceIntent,
): Promise<RemittanceResolution> {
  if (intent.amount == null || intent.amount <= 0) {
    return { ok: false, message: `How much would you like to send? e.g. "send $50 to a bank account in Nigeria".` };
  }

  // A saved recipient (e.g. "mom") skips country/institution/account
  // resolution entirely — those were already settled the first time this
  // recipient was saved. This is the whole point of saving one.
  if (intent.recipientNickname) {
    const saved = await recipientsRepo.findByNickname(userId, intent.recipientNickname);
    if (saved) {
      // saved.institution can be coded in a DIFFERENT provider's namespace
      // than Paycrest's — real bug found live (2026-08-27): a recipient
      // saved while a Centiiv order won the rate stores Centiiv's code
      // ("100004" for OPay), not Paycrest's ("OPAYNGPC"). Every downstream
      // assumption in this function (see the "Quidax is only ever used
      // here..." comment below) requires recipient.institution to already
      // be a valid Paycrest code — true for a freshly-resolved recipient
      // (matched against Paycrest's own list), but never re-checked for a
      // saved one, so a stale cross-provider code sailed straight into a
      // Paycrest order and got rejected with "institution is not
      // supported". Re-resolving here, by name, against Paycrest's live
      // list — same fuzzy matcher already used everywhere else — self-
      // heals it before it ever reaches an order. Falls back to the
      // stored code on any lookup failure or ambiguous/zero match, so
      // this can only improve on the status quo, never block a send that
      // already worked.
      let institution = saved.institution;
      let institutionName = saved.institutionName;
      try {
        const paycrestInstitutions = await getInstitutions(saved.fiatCurrency);
        const matches = findInstitutionMatches(saved.institutionName, paycrestInstitutions);
        if (matches.length === 1) {
          institution = matches[0]!.code;
          institutionName = matches[0]!.name;
        } else {
          console.log(
            `[remittance-draft] saved recipient "${saved.nickname}" institution "${saved.institutionName}" (code ${saved.institution}) found ${matches.length} matches on Paycrest's ${saved.fiatCurrency} list (need exactly 1) — using the stored code as-is.`,
          );
        }
      } catch (err) {
        console.error(`[remittance-draft] failed to re-validate saved recipient "${saved.nickname}" against Paycrest's institution list:`, err);
      }
      const recipient: SendRecipient = {
        institution,
        institutionName,
        accountIdentifier: saved.accountIdentifier,
        accountName: saved.accountName,
        memo: saved.nickname,
      };
      return finalizeRemittanceDraft(
        userId,
        intent.amount,
        saved.fiatCurrency,
        ` (${saved.institutionName})`,
        recipient,
        intent.chainHint,
        intent.tokenHint,
      );
    }
  }

  let country = resolveCountry(intent.countryHint);
  let matched: Institution | null = null;

  // Country wasn't named, but an institution was — try inferring it before
  // asking a question the institution name might already answer.
  if (!country && intent.institutionHint) {
    const inferred = await resolveInstitutionAcrossCountries(intent.institutionHint);
    if (inferred) {
      country = inferred.country;
      matched = inferred.institution;
    }
  }

  if (!country) {
    return {
      ok: false,
      message: `Which country is this going to? I currently support ${SUPPORTED_COUNTRIES.join(", ")}.`,
    };
  }

  if (!intent.institutionHint) {
    return { ok: false, message: `Which bank or mobile money provider should I send to?` };
  }

  if (!intent.accountIdentifier) {
    return { ok: false, message: `What's the account number or phone number to send to?` };
  }

  // Only re-resolve the institution against this country's list if the
  // cross-country search above didn't already nail it down.
  if (!matched) {
    let institutions;
    try {
      institutions = await getInstitutions(country.currencyCode);
    } catch {
      return { ok: false, message: `I couldn't look up providers for ${country.name} right now — try again shortly.` };
    }

    matched = findInstitutionMatches(intent.institutionHint, institutions)[0] ?? null;
    if (!matched) {
      matched = await resolveInstitutionWithLlm(intent.institutionHint, institutions);
    }
    if (!matched) {
      return { ok: false, message: describeInstitutionPrompt(institutions) };
    }
  }

  let verified;
  try {
    verified = await verifyRecipientAccount({
      institution: matched.code,
      accountIdentifier: intent.accountIdentifier,
    });
  } catch {
    return {
      ok: false,
      message: `I couldn't verify that account at ${matched.name} — double check the number and try again.`,
    };
  }

  // The user may have re-entered this account fresh instead of referencing
  // it by nickname — check whether it's already saved under one so `memo`
  // still gets set. The frontend reads memo's presence as "already saved";
  // leaving it unset here for an already-saved account is exactly what was
  // prompting users to save the same recipient again on a second transfer.
  const alreadySaved = await recipientsRepo.findByAccountIdentifier(userId, matched.code, intent.accountIdentifier);
  const nicknameForMemo = intent.recipientNickname ?? alreadySaved?.nickname;

  const recipient: SendRecipient = {
    institution: matched.code,
    institutionName: matched.name,
    accountIdentifier: intent.accountIdentifier,
    accountName: verified.accountName,
    ...(nicknameForMemo ? { memo: nicknameForMemo } : {}),
  };

  return finalizeRemittanceDraft(
    userId,
    intent.amount,
    country.currencyCode,
    ` (${matched.name}) in ${country.name}`,
    recipient,
    intent.chainHint,
    intent.tokenHint,
  );
}
