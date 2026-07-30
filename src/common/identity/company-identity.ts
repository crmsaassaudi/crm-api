/**
 * Company-identity normalisation, for detecting that two account records are the
 * same organisation.
 *
 * The contact equivalent (`identity-normalizer.ts`) can be strict, because an email
 * address either matches or it does not. A company has no such key: "Acme Corp",
 * "ACME, Inc." and "Acme Corporation" may be one organisation or three, and no amount
 * of string processing can tell you which.
 *
 * So this module does NOT produce a uniqueness key. It produces **signals with
 * confidence**, and the caller decides what to do with each. That distinction is the
 * whole design:
 *
 *   - `taxId` — an exact match IS the same legal entity. Tax IDs are unique by
 *     definition; two records sharing one are the same company, full stop.
 *   - `domain` — a strong signal. Organisations do not share a registrable domain,
 *     so `acme.com` on two accounts almost always means a duplicate. "Almost":
 *     subsidiaries sometimes share a parent's domain, which is exactly why this is
 *     strong rather than exact.
 *   - `name` — a weak signal, useful only for warning a human. Suffix stripping makes
 *     "Acme Ltd" and "Acme GmbH" collide, and those are *different legal entities* in
 *     different jurisdictions. Treating a name match as authoritative would merge real
 *     companies.
 *
 * Nothing here is used to block a write. It is used to say "these look like the same
 * company — is that what you meant?", which is the only honest thing to do with a
 * signal that cannot be certain.
 */

export type CompanyMatchConfidence = 'exact' | 'strong' | 'weak';

/**
 * Legal-form suffixes stripped before comparing names.
 *
 * Deliberately includes Vietnamese forms alongside the Anglo/European ones — this
 * product's tenants are largely Vietnamese, and a suffix list that only knows "Inc"
 * and "Ltd" would fail to match "Công ty TNHH Acme" against "Acme" while cheerfully
 * matching the English cases, which is a worse experience than matching neither.
 */
const LEGAL_SUFFIXES = [
  // Vietnamese
  'cong ty tnhh mtv',
  'cong ty tnhh',
  'cong ty co phan',
  'cong ty cp',
  'cong ty',
  'tnhh mtv',
  'tnhh',
  'co phan',
  'jsc',
  'cp',
  // Anglo / European
  'incorporated',
  'corporation',
  'company',
  'limited',
  'holdings',
  'holding',
  'group',
  'inc',
  'corp',
  'llc',
  'llp',
  'ltd',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'nv',
  'bv',
  'oy',
  'ab',
  'as',
  'pte',
  'pty',
  'co',
];

/**
 * Comparison key for a company name. Weak signal — see the module comment.
 *
 * Strips diacritics so "Công ty" and "Cong ty" fold together, drops punctuation,
 * removes legal-form suffixes from either end, and collapses whitespace.
 */
export function normalizeCompanyName(value: string): string {
  if (typeof value !== 'string') return '';

  let name = value
    .normalize('NFD')
    // Combining marks: "Cộng" → "Cong". Vietnamese text is full of them and a user
    // typing the same company twice will not reproduce them identically.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Đ/đ has no combining form, so NFD leaves it alone.
    .replace(/đ/g, 'd')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip suffixes repeatedly: "Acme Holdings Ltd" needs two passes. Longest-first so
  // "cong ty tnhh" wins over "cong ty".
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (name === suffix) continue; // a name that IS only a suffix keeps it
      if (name.endsWith(` ${suffix}`)) {
        name = name.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
      if (name.startsWith(`${suffix} `)) {
        name = name.slice(suffix.length + 1).trim();
        changed = true;
        break;
      }
    }
  }

  return name;
}

/**
 * The registrable domain of a website. Strong signal.
 *
 * Accepts anything a user might paste — a bare domain, a full URL, one with a path or
 * query, with or without `www.`. Returns '' when there is no domain to find, because a
 * caller must never treat "could not parse" as "matches everything".
 *
 * Public-suffix handling is deliberately shallow: `co.uk`, `com.vn` and friends are
 * recognised as two-label suffixes so `acme.com.vn` keeps its `acme`, but this is not
 * a full PSL implementation. A wrong answer here over-matches within one organisation's
 * own domain space, which is the harmless direction.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.vn',
  'net.vn',
  'org.vn',
  'edu.vn',
  'gov.vn',
  'com.au',
  'net.au',
  'com.sg',
  'com.my',
  'co.jp',
  'co.kr',
  'com.br',
  'co.in',
  'com.cn',
]);

export function normalizeWebsiteDomain(value: string): string {
  if (typeof value !== 'string') return '';

  let host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
    .replace(/^[^/@]*@/, '') // credentials
    .split(/[/?#]/)[0] // path, query, fragment
    .split(':')[0] // port
    .replace(/\.$/, ''); // trailing dot on a FQDN

  if (!host || !host.includes('.')) return '';
  // An IP address is not a company identity.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '';
  if (host.startsWith('www.')) host = host.slice(4);

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return '';

  const lastTwo = labels.slice(-2).join('.');
  const take = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * Comparison key for a tax / registration number. Exact signal.
 *
 * Strips formatting only — a tax ID's characters are the identity, and two records
 * carrying the same one are the same legal entity.
 */
export function normalizeTaxId(value: string): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export interface CompanyIdentity {
  nameKey: string;
  domain: string;
  taxIdKey: string;
}

/** Derive every comparison key an account document offers. */
export function deriveCompanyIdentity(account: {
  name?: string;
  website?: string;
  taxId?: string;
}): CompanyIdentity {
  return {
    nameKey: normalizeCompanyName(account.name ?? ''),
    domain: normalizeWebsiteDomain(account.website ?? ''),
    taxIdKey: normalizeTaxId(account.taxId ?? ''),
  };
}

/**
 * How confident we are that two accounts are the same organisation, or null when
 * nothing matches.
 *
 * Highest-confidence signal wins: a shared tax ID settles it regardless of the names,
 * and differing tax IDs do NOT veto a domain match, because one of the two records may
 * simply not have a tax ID recorded.
 */
export function compareCompanyIdentity(
  left: CompanyIdentity,
  right: CompanyIdentity,
): { confidence: CompanyMatchConfidence; matchedOn: string } | null {
  if (left.taxIdKey && left.taxIdKey === right.taxIdKey) {
    return { confidence: 'exact', matchedOn: 'taxId' };
  }
  if (left.domain && left.domain === right.domain) {
    return { confidence: 'strong', matchedOn: 'website' };
  }
  if (left.nameKey && left.nameKey === right.nameKey) {
    return { confidence: 'weak', matchedOn: 'name' };
  }
  return null;
}
