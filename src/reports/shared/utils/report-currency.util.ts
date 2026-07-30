import { Model } from 'mongoose';

/**
 * Detect whether a report is about to sum money across more than one currency.
 *
 * Every deal report aggregates `$sum: '$value'` and none of them reference
 * `currency`. For a single-currency tenant that is correct. For a tenant holding
 * USD, EUR and VND deals it produces the arithmetic sum of unlike units — and
 * because VND runs at roughly 24,000 to the dollar, one VND deal dominates the
 * total by orders of magnitude. The number is not merely imprecise, it is
 * meaningless, and nothing in the response said so.
 *
 * This does not convert. Converting requires an exchange-rate source and a policy
 * decision that belongs to the business, not to a util — rate at close or rate
 * today, and which provider is authoritative. Both answers are defensible and they
 * produce different revenue figures, so picking one here would be inventing an
 * accounting policy.
 *
 * What it does instead is make the ambiguity visible: report the currencies present
 * so the caller can attach a warning, and let a single-currency tenant — the common
 * case — pay only one `distinct` query for the check.
 */

/** Currencies above this many are listed as a count rather than enumerated. */
const MAX_LISTED = 6;

export interface CurrencyMix {
  /** Distinct currency codes in the matched set, upper-cased and sorted. */
  currencies: string[];
  /** True when a summed total spans more than one currency. */
  isMixed: boolean;
  /** Ready-to-attach warning, or undefined when the totals are unambiguous. */
  warning?: string;
}

export async function detectCurrencyMix(
  model: Model<any>,
  match: Record<string, unknown>,
): Promise<CurrencyMix> {
  let raw: unknown[];
  try {
    raw = await model.distinct('currency', match);
  } catch {
    // A failed check must not fail the report. Reporting "not mixed" would be a lie,
    // so report unknown-but-unmixed and stay silent rather than warn spuriously —
    // the totals are exactly as trustworthy as they were before this existed.
    return { currencies: [], isMixed: false };
  }

  const currencies = Array.from(
    new Set(
      raw
        .filter(
          (c): c is string => typeof c === 'string' && c.trim().length > 0,
        )
        .map((c) => c.trim().toUpperCase()),
    ),
  ).sort();

  if (currencies.length <= 1) {
    return { currencies, isMixed: false };
  }

  const listed =
    currencies.length <= MAX_LISTED
      ? currencies.join(', ')
      : `${currencies.slice(0, MAX_LISTED).join(', ')} and ${
          currencies.length - MAX_LISTED
        } more`;

  return {
    currencies,
    isMixed: true,
    warning:
      `Totals combine ${currencies.length} currencies (${listed}) without conversion, ` +
      'so monetary figures in this report are not comparable. Filter to a single ' +
      'currency for a meaningful total.',
  };
}
