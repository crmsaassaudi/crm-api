import { buildMessageSnippet } from './message-snippet';
import {
  decodeMessageSearchCursor,
  encodeMessageSearchCursor,
} from './message-search-cursor';

describe('buildMessageSnippet', () => {
  it('should centre the window on the first match', () => {
    const content = `${'a'.repeat(400)} refund ${'b'.repeat(400)}`;
    const snippet = buildMessageSnippet(content, 'refund');
    expect(snippet.text).toContain('refund');
    expect(snippet.text.length).toBeLessThanOrEqual(160);
    expect(snippet.truncated).toBe(true);
  });

  it('should match case-insensitively and report offsets into the snippet', () => {
    const snippet = buildMessageSnippet(
      'Please issue a REFUND today',
      'refund',
    );
    const first = snippet.matches[0];
    expect(first).toBeDefined();
    expect(snippet.text.slice(first.start, first.end).toLowerCase()).toBe(
      'refund',
    );
  });

  it('should keep a match near the start fully visible', () => {
    const content = `refund ${'x'.repeat(500)}`;
    const snippet = buildMessageSnippet(content, 'refund');
    expect(snippet.matches[0]).toEqual({ start: 0, end: 6 });
  });

  it('should keep a match near the end fully visible', () => {
    const content = `${'x'.repeat(500)} refund`;
    const snippet = buildMessageSnippet(content, 'refund');
    const first = snippet.matches[0];
    expect(snippet.text.slice(first.start, first.end)).toBe('refund');
  });

  it('should return markup-free text and offsets, never HTML', () => {
    // The body is customer-controlled. If this ever returned markup, a message
    // could inject it into the agent's console.
    const snippet = buildMessageSnippet(
      '<img src=x onerror=alert(1)> refund',
      'refund',
    );
    expect(snippet.text).toContain('<img src=x onerror=alert(1)>');
    expect(snippet.text).not.toContain('<mark');
    expect(snippet.matches).toHaveLength(1);
  });

  it('should degrade to the head of the message when no substring matches', () => {
    const snippet = buildMessageSnippet('hello world', 'zzz');
    expect(snippet.text).toBe('hello world');
    expect(snippet.matches).toEqual([]);
  });

  it('should handle empty content and empty term without throwing', () => {
    expect(buildMessageSnippet('', 'refund').text).toBe('');
    expect(buildMessageSnippet('hello', '').matches).toEqual([]);
  });

  it('should cap the number of reported matches', () => {
    const snippet = buildMessageSnippet('ab '.repeat(80), 'ab');
    expect(snippet.matches.length).toBeLessThanOrEqual(5);
  });
});

describe('message search cursor', () => {
  const cursor = {
    providerTimestamp: new Date('2026-08-01T10:00:00.000Z'),
    sequence: 7,
    id: '66aa0000aa0000aa0000aa00',
  };

  it('should round-trip all three sort components', () => {
    // All three travel because the sort has all three: providers report whole
    // seconds, so a burst shares a timestamp and a timestamp-only cursor would
    // skip messages at the page boundary.
    const decoded = decodeMessageSearchCursor(
      encodeMessageSearchCursor(cursor),
    );
    expect(decoded).toEqual(cursor);
  });

  it('should return null for an absent cursor', () => {
    expect(decodeMessageSearchCursor(undefined)).toBeNull();
  });

  it('should reject a malformed cursor rather than silently restarting', () => {
    expect(() => decodeMessageSearchCursor('not-base64!!')).toThrow();
    expect(() =>
      decodeMessageSearchCursor(
        Buffer.from(JSON.stringify({ v: 2 })).toString('base64url'),
      ),
    ).toThrow();
    expect(() =>
      decodeMessageSearchCursor(
        Buffer.from(JSON.stringify({ v: 1, t: 'nope', i: 'x' })).toString(
          'base64url',
        ),
      ),
    ).toThrow();
  });
});
