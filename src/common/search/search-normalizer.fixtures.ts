/**
 * The table both engines are held to.
 *
 * Imported by `search-normalizer.spec.ts` (MongoDB side, pure function) and by
 * `search-analyzer-parity.int-spec.ts` (OpenSearch side, real cluster
 * `_analyze`). One table, two enforcement points — which is the only way a
 * per-tenant engine switch can be safe: the tenant moved to OpenSearch has to
 * keep finding the records they could find yesterday.
 *
 * Scope of the promise
 * --------------------
 * These cases assert **folding** — whether two spellings are the same word.
 * They do not assert **word breaking** beyond the obvious: MongoDB splits on
 * "not a letter or digit" while OpenSearch's standard tokenizer implements
 * UAX#29, so `don't` and `3.14` legitimately differ. Names, companies, phone
 * numbers and ticket references — everything a CRM search box actually receives
 * — break the same way in both, and those are the cases below.
 */

export interface NormalizerCase {
  /** What a user types, or what a record contains. */
  input: string;
  /** Tokens both engines must produce. */
  expected: string[];
  /** Why this case exists. Shown in the test name. */
  why: string;
}

export const NORMALIZER_CASES: NormalizerCase[] = [
  // Arabic orthography: the reason this file exists
  {
    input: 'أحمد',
    expected: ['احمد'],
    why: 'alef with hamza above folds to bare alef',
  },
  {
    input: 'احمد',
    expected: ['احمد'],
    why: 'bare alef is already canonical',
  },
  {
    input: 'إبراهيم',
    expected: ['ابراهيم'],
    why: 'alef with hamza below folds to bare alef',
  },
  {
    input: 'آمنة',
    expected: ['امنه'],
    why: 'alef madda folds, and teh marbuta folds to heh',
  },
  {
    input: 'شركة',
    expected: ['شركه'],
    why: 'teh marbuta and heh are written interchangeably',
  },
  { input: 'شركه', expected: ['شركه'], why: 'the other spelling of the same' },
  {
    input: 'على',
    expected: ['علي'],
    why: 'alef maksura folds to yeh — Ali is written both ways',
  },
  { input: 'علي', expected: ['علي'], why: 'the other spelling of the same' },
  {
    input: 'محمـــد',
    expected: ['محمد'],
    why: 'tatweel is decoration, not letters',
  },
  {
    input: 'مُحَمَّد',
    expected: ['محمد'],
    why: 'harakat are removed — most text omits them',
  },
  {
    input: 'شركة الاتصالات السعودية',
    expected: ['شركه', 'الاتصالات', 'السعوديه'],
    why: 'a real company name, three tokens',
  },

  // Arabic-Indic digits: a phone number typed in Arabic numerals
  {
    input: '٠٥٠١٢٣٤٥٦٧',
    expected: ['0501234567'],
    why: 'Arabic-Indic digits are the same number',
  },
  {
    input: '۰۵۰۱۲۳',
    expected: ['050123'],
    why: 'Extended Arabic-Indic digits (Persian keyboards)',
  },
  {
    input: '٩٦٦٥٠',
    expected: ['96650'],
    why: 'country code typed in Arabic numerals',
  },

  // Vietnamese diacritics
  {
    input: 'Nguyễn',
    expected: ['nguyen'],
    why: 'combining marks are stripped, not merely decomposed',
  },
  { input: 'Nguyen', expected: ['nguyen'], why: 'the unaccented spelling' },
  {
    input: 'Trần Thị Hoà',
    expected: ['tran', 'thi', 'hoa'],
    why: 'a full Vietnamese name',
  },
  { input: 'Đà Nẵng', expected: ['da', 'nang'], why: 'đ folds to d' },

  // Latin
  { input: 'ACME', expected: ['acme'], why: 'case is folded' },
  {
    input: 'Acme Corp.',
    expected: ['acme', 'corp'],
    why: 'trailing punctuation is not part of the word',
  },
  {
    input: 'Al-Rashid',
    expected: ['al', 'rashid'],
    why: 'hyphenated names split — typing either half must match',
  },
  {
    input: 'José Álvarez',
    expected: ['jose', 'alvarez'],
    why: 'Spanish diacritics fold like Vietnamese ones',
  },

  // Phone and reference shapes
  {
    input: '+966 50 123 4567',
    expected: ['966', '50', '123', '4567'],
    why: 'punctuation-separated groups become separate tokens',
  },
  {
    input: 'TKT-000123',
    expected: ['tkt', '000123'],
    why: 'ticket reference splits on the hyphen',
  },

  // Boundaries
  { input: '', expected: [], why: 'empty input yields nothing' },
  { input: '   ', expected: [], why: 'whitespace only yields nothing' },
  {
    input: 'a',
    expected: [],
    why: 'single characters match almost everything and are not indexed',
  },
  {
    input: '!!! ??? ---',
    expected: [],
    why: 'punctuation carries no token',
  },
];

/**
 * Where the two engines legitimately disagree, pinned so it cannot grow.
 *
 * Folding is shared; **word breaking** is not. MongoDB splits on "not a letter
 * and not a digit"; OpenSearch's standard tokenizer implements UAX#29, which
 * deliberately keeps an e-mail address and an apostrophised name whole. Writing
 * a UAX#29 implementation in JavaScript to close a two-case gap would be a
 * large amount of machinery for a small amount of agreement, so the difference
 * is declared instead.
 *
 * Declared, not ignored: both sides are asserted, so if either tokenizer
 * changes the suite goes red and someone decides deliberately rather than
 * finding out from a tenant.
 *
 * What it means in practice, for the person answering the support ticket:
 * on MongoDB a contact is findable by any *part* of their e-mail address; on
 * OpenSearch, by the whole address or by an edge n-gram prefix of it. Both
 * find the contact; the paths differ. E-mail lives in the masked half either
 * way, so this is only reachable by a caller holding `contacts:unmask`.
 */
export interface DivergenceCase {
  input: string;
  mongo: string[];
  openSearch: string[];
  why: string;
}

export const TOKENIZER_DIVERGENCE_CASES: DivergenceCase[] = [
  {
    input: 'ahmed.ali@example.com',
    mongo: ['ahmed', 'ali', 'example', 'com'],
    // Measured, not predicted: UAX#29 splits at `@` but treats a full stop
    // between letters as mid-word, so it yields two tokens rather than the one
    // this table originally guessed.
    openSearch: ['ahmed.ali', 'example.com'],
    why: 'UAX#29 keeps dotted runs whole and splits only at the @',
  },
  {
    input: 'O’Brien',
    mongo: ['brien'],
    // `asciifolding` turns the curly apostrophe into a straight one, and UAX#29
    // treats it as mid-word — so the whole name survives as a single token.
    // Practical effect: on OpenSearch "o'brien" or "o'b" matches and "brien"
    // does not; on MongoDB the reverse.
    openSearch: ["o'brien"],
    why: 'UAX#29 treats an apostrophe as mid-word',
  },
];
