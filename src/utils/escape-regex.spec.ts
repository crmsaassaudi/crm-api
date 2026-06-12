import { escapeRegex } from './escape-regex';

describe('escapeRegex', () => {
  it('should escape special regex characters', () => {
    const input = 'hello.*+?^${}()|[]\\world';
    const result = escapeRegex(input);
    // Every special char should be preceded by \\
    expect(result).not.toContain('.*');
    expect(result).toContain('\\.');
    expect(result).toContain('\\*');
    expect(result).toContain('\\+');
    expect(result).toContain('\\?');
    expect(result).toContain('\\^');
    expect(result).toContain('\\$');
  });

  it('should handle empty string', () => {
    expect(escapeRegex('')).toBe('');
  });

  it('should pass through safe strings unchanged', () => {
    expect(escapeRegex('hello world')).toBe('hello world');
  });

  it('should truncate input to MAX_SEARCH_LENGTH (100 chars)', () => {
    const long = 'a'.repeat(200);
    const result = escapeRegex(long);
    expect(result).toHaveLength(100);
  });

  it('should handle ReDoS pattern safely', () => {
    // This pattern would cause catastrophic backtracking if unescaped
    const redos = '(a+)+$';
    const result = escapeRegex(redos);
    expect(result).toContain('\\(');
    expect(result).toContain('\\+');
    expect(result).toContain('\\$');
    // Verify the escaped result is safe to use in RegExp
    expect(() => new RegExp(result)).not.toThrow();
  });

  it('should handle non-string input by converting to string', () => {
    // The function calls String() internally
    expect(escapeRegex(123 as any)).toBe('123');
    expect(escapeRegex(null as any)).toBe('null');
  });
});
