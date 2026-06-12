/**
 * HIGH-03: Neutralize spreadsheet formula injection in exported cell values.
 *
 * Excel and Google Sheets interpret cells starting with `=`, `+`, `-`, `@`,
 * tab, or CR as formulas. An attacker can craft a contact name like
 * `=cmd|'/c calc'!A1` which executes when staff open the export.
 *
 * Defence: prefix dangerous leading characters with a single-quote `'`
 * which tells the spreadsheet engine to treat the cell as literal text.
 *
 * Special case: negative numbers starting with `-` followed by a digit
 * are NOT prefixed (they're legitimate numeric values, not formulas).
 */
const FORMULA_INJECTION_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function sanitizeCellValue(value: string): string {
  if (!value || value.length === 0) return value;
  const firstChar = value[0];
  if (!FORMULA_INJECTION_CHARS.has(firstChar)) return value;

  // Allow negative numbers: -123, -0.5, etc.
  if (firstChar === '-' && value.length > 1 && /\d/.test(value[1])) {
    return value;
  }

  return `'${value}`;
}
