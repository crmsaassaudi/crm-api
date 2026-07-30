import * as fs from 'fs';
import * as path from 'path';
import { validateConversationId } from './gateway-dto';

describe('validateConversationId', () => {
  it('should accept a 24-char hex id under either key', () => {
    expect(
      validateConversationId({ conversationId: '60d0fe4f5311236168a109ca' }),
    ).toBeNull();
    // Some events carry it as `id` rather than `conversationId`.
    expect(
      validateConversationId({ id: '60d0fe4f5311236168a109ca' }),
    ).toBeNull();
  });

  it('should reject a missing or non-string id', () => {
    expect(validateConversationId({})).toBe('conversationId is required');
    expect(validateConversationId(null)).toBe('Invalid payload');
    expect(validateConversationId({ conversationId: 123 })).toBe(
      'conversationId is required',
    );
  });

  it('should reject an id that is not a 24-char hex string', () => {
    // The shape that mattered: anything else becomes a Redis key fragment and a
    // Mongo filter downstream.
    for (const bad of [
      'not-an-id',
      '../../etc/passwd',
      'zzzzzzzzzzzzzzzzzzzzzzzz',
    ]) {
      expect(validateConversationId({ conversationId: bad })).toBe(
        'conversationId must be a valid 24-char hex string',
      );
    }
  });
});

/**
 * Structural guard, not behavioural: the gateway is one 1800-line class whose
 * handlers are reached through Socket.IO, so "did this handler validate?" is far
 * cheaper to assert against the source than to exercise.
 *
 * It exists because four of nine conversation-scoped handlers validated and five did
 * not, while `validateConversationId` — written for exactly those five — sat with no
 * caller at all. The asymmetry is invisible when reading any single handler.
 */
describe('omni.gateway conversation-scoped handlers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'omni.gateway.ts'),
    'utf8',
  );

  /** Split the class into one chunk per @SubscribeMessage handler. */
  const handlers = source
    .split('@SubscribeMessage(')
    .slice(1)
    .map((chunk) => ({
      event: chunk.slice(0, chunk.indexOf(')')).replace(/['"]/g, ''),
      body: chunk,
    }));

  it('should find the handlers (guard is wired to real source)', () => {
    expect(handlers.length).toBeGreaterThan(8);
    expect(handlers.map((h) => h.event)).toContain('conversation.subscribe');
  });

  it('should validate the conversationId in every handler that takes one', () => {
    const offenders = handlers
      .filter((h) => /conversationId\s*:\s*string/.test(h.body))
      .filter((h) => !/validate[A-Za-z]*\(\s*data\s*\)/.test(h.body))
      .map((h) => h.event);

    expect(offenders).toEqual([]);
  });
});
