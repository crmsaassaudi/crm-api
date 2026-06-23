/**
 * T-037: Validation helpers for OmniGateway socket message payloads.
 *
 * These are lightweight synchronous validators — no class-validator/class-transformer
 * overhead for the hot socket path. Returns a descriptive error string or null if valid.
 */

const MONGO_ID_RE = /^[0-9a-f]{24}$/i;
const MAX_CONTENT_LENGTH = 10_000;
const MAX_CAPTION_LENGTH = 2_000;

export function validateSendMessage(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  if (!data.content && !data.text) return 'content or text is required';
  const content = data.content ?? data.text;
  if (typeof content !== 'string') return 'content must be a string';
  if (content.length > MAX_CONTENT_LENGTH)
    return `content exceeds max length of ${MAX_CONTENT_LENGTH} characters`;
  return null;
}

export function validateSendMedia(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  if (!data.fileId && !data.base64 && !data.url)
    return 'fileId, base64, or url is required';
  if (
    data.caption &&
    typeof data.caption === 'string' &&
    data.caption.length > MAX_CAPTION_LENGTH
  )
    return `caption exceeds max length of ${MAX_CAPTION_LENGTH} characters`;
  return null;
}

export function validateSendTemplate(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  if (!data.templateName || typeof data.templateName !== 'string')
    return 'templateName is required';
  if (!data.languageCode || typeof data.languageCode !== 'string')
    return 'languageCode is required';
  return null;
}

export function validateConversationId(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  const id = data.conversationId ?? data.id;
  if (!id || typeof id !== 'string') return 'conversationId is required';
  if (!MONGO_ID_RE.test(id))
    return 'conversationId must be a valid 24-char hex string';
  return null;
}

export function validateReaction(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  if (!data.messageId || typeof data.messageId !== 'string')
    return 'messageId is required';
  if (!data.emoji || typeof data.emoji !== 'string') return 'emoji is required';
  // Emoji length check: max 10 chars (handles multi-codepoint emoji like 👨‍👩‍👧‍👦)
  if (data.emoji.length > 10) return 'emoji is too long';
  return null;
}

export function validateTyping(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  return null;
}

export function validateSendInteractive(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  if (!data.body || typeof data.body !== 'string')
    return 'body text is required';
  if (data.body.length > MAX_CONTENT_LENGTH)
    return `body exceeds max length of ${MAX_CONTENT_LENGTH} characters`;
  if (!Array.isArray(data.buttons) || data.buttons.length === 0)
    return 'at least 1 button is required';
  if (data.buttons.length > 10)
    return 'maximum 10 buttons allowed';
  for (const btn of data.buttons) {
    if (!btn.title || typeof btn.title !== 'string')
      return 'each button must have a title';
    if (btn.title.length > 200)
      return 'button title must not exceed 200 characters';
  }
  return null;
}

export function validateSendCarousel(data: any): string | null {
  if (!data || typeof data !== 'object') return 'Invalid payload';
  if (!data.conversationId || typeof data.conversationId !== 'string')
    return 'conversationId is required';
  if (!MONGO_ID_RE.test(data.conversationId))
    return 'conversationId must be a valid 24-char hex string';
  if (!Array.isArray(data.cards) || data.cards.length === 0)
    return 'at least 1 card is required';
  if (data.cards.length > 10)
    return 'maximum 10 cards allowed';
  for (const card of data.cards) {
    if (!card.title || typeof card.title !== 'string')
      return 'each card must have a title';
  }
  return null;
}
