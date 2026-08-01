export interface MessageSnippet {
  /** A window of the message body around the first match. */
  text: string;
  /** Offsets of the match inside `text`, for the client to mark up. */
  matches: Array<{ start: number; end: number }>;
  /** True when `text` is shorter than the message body. */
  truncated: boolean;
}

const DEFAULT_WINDOW = 160;
const MAX_MATCHES = 5;

/**
 * Build a snippet of `content` around the occurrences of `term`.
 *
 * Why the server does this rather than shipping whole message bodies and letting
 * the browser find the term: a search over a long thread would otherwise send
 * kilobytes per hit for a list that shows two lines, and every client would
 * reimplement the same case- and offset-handling — usually by injecting HTML,
 * which turns a customer's message into an XSS vector.
 *
 * Returns offsets rather than markup for exactly that reason: the caller decides
 * how to render, and no markup is ever interpolated into user content here.
 */
export function buildMessageSnippet(
  content: string,
  term: string,
  windowSize = DEFAULT_WINDOW,
): MessageSnippet {
  const body = content ?? '';
  const needle = term.trim();
  if (!body || !needle) {
    return {
      text: body.slice(0, windowSize),
      matches: [],
      truncated: body.length > windowSize,
    };
  }

  const haystack = body.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const first = haystack.indexOf(lowerNeedle);
  if (first < 0) {
    // The regex matched but a plain substring scan does not — possible when the
    // two disagree on locale folding. Fall back to the head of the message
    // rather than returning nothing, so the row still renders.
    return {
      text: body.slice(0, windowSize),
      matches: [],
      truncated: body.length > windowSize,
    };
  }

  // Centre the window on the first match, then clamp into the string. Clamping
  // after centring keeps a match near either end fully visible instead of
  // sliding the window off the text.
  const half = Math.floor((windowSize - lowerNeedle.length) / 2);
  let start = Math.max(0, first - Math.max(0, half));
  const end = Math.min(body.length, start + windowSize);
  start = Math.max(0, Math.min(start, Math.max(0, end - windowSize)));

  const text = body.slice(start, end);
  const localHaystack = text.toLocaleLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (matches.length < MAX_MATCHES) {
    const found = localHaystack.indexOf(lowerNeedle, cursor);
    if (found < 0) break;
    matches.push({ start: found, end: found + needle.length });
    cursor = found + Math.max(1, needle.length);
  }

  return {
    text,
    matches,
    truncated: start > 0 || end < body.length,
  };
}
