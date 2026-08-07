import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

/**
 * Every `@OnEvent` must name an event something actually emits.
 *
 * This is the defect class behind three of the worst bugs in the omni module, and
 * all three compiled, passed their unit tests, and failed silently in production:
 *
 *  - `SlaCancellationListener` listened on `omni.outbound.message.sent`; every
 *    emitter uses `omni.message.sent`. Nothing ever cancelled a first-response
 *    breach check, so every conversation still open at its deadline was recorded
 *    as an SLA breach no matter how fast the agent answered — and that flag fed
 *    the escalation policies and every SLA figure in the reports.
 *  - `TelegramService` emitted `omni.inbound.message`, which has no listener
 *    anywhere. Telegram messages were received, validated, normalised, and
 *    dropped.
 *  - `omni.conversation.sla_breached` had two listeners and no emitter, so the
 *    conversation activity trail never recorded a breach and the daily-metrics
 *    projection's `slaBreachedCount` was permanently zero.
 *
 * A name typed twice and matched never. `OmniEvents` exists to prevent exactly
 * this, and each of the three broken call sites bypassed it with a raw string —
 * so the constant alone is not enough of a guard. This test is.
 *
 * Static, deliberately: booting the module graph needs Mongo, Redis and BullMQ,
 * and this question does not.
 */

/**
 * The surface this test currently asserts over.
 *
 * `contact.`, `account.`, `ticket.`, `task.` and `deal.` joined the scope once
 * {@link collectEntityAuditEmits} closed the blind spot that first made them look
 * orphaned: `EntityAuditService.emit({entity, kind})` composes the event name as
 * `` `${entity}.${kind}` ``, which no regex over literal `.emit('...')` strings
 * can see. `record-auto-assignment.listener` and `record-workload.listener`
 * subscribe to `account.created`/`ticket.created`/`task.created`/`deal.created`
 * and their `.updated` pairs — a first pass over raw string literals alone found
 * no emitter for any of them and concluded record auto-assignment and workload
 * tracking were inert for every module. They are not: every one of those events is
 * emitted, through `EntityAuditService`, from the owning module's service. A tool
 * that cannot see its own platform's central emit path is worse than no tool —
 * the false alarm it would have produced was one commit away from someone
 * "fixing" a system that already worked.
 */
const AUDITED_PREFIXES = [
  'omni.',
  'livechat.',
  'sla.',
  'csat.',
  'contact.',
  'account.',
  'ticket.',
  'task.',
  'deal.',
];

const inScope = (event: string) =>
  AUDITED_PREFIXES.some((prefix) => event.startsWith(prefix));

/** Events published by infrastructure outside this repo's emit call sites. */
const EXTERNAL_EVENTS = new Set([
  // BullMQ worker lifecycle, emitted by @nestjs/bullmq.
  'failed',
  'completed',
  'error',
  'stalled',
  'active',
  'progress',
  'waiting',
  'drained',
  'paused',
  'resumed',
]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, files);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Every string literal event name inside `@OnEvent(...)`, with its file. */
function collectListeners(sources: Map<string, string>) {
  const listeners: Array<{ event: string; file: string }> = [];
  for (const [file, source] of sources) {
    // `@OnEvent('name')` and `@OnEvent('name', { async: true })`.
    for (const match of source.matchAll(/@OnEvent\(\s*'([^']+)'/g)) {
      listeners.push({ event: match[1], file });
    }
  }
  return listeners;
}

/**
 * Every string literal event name passed to an emit call.
 *
 * Listeners that reference `OmniEvents.X` resolve through the constant map, which
 * is handled separately — this covers the raw-string half where the drift lives.
 */
function collectEmitted(sources: Map<string, string>) {
  const emitted = new Set<string>();
  for (const source of sources.values()) {
    for (const match of source.matchAll(/\.emit(?:Async)?\(\s*'([^']+)'/g)) {
      emitted.add(match[1]);
    }
    // Redis pub/sub and socket emits share the `.emit(` shape; harmless overlap.
    for (const match of source.matchAll(/publish\(\s*'([^']+)'/g)) {
      emitted.add(match[1]);
    }
  }
  return emitted;
}

/**
 * The object-literal argument of a call starting at `openBraceIndex` — the `{`
 * right after `entityAudit.emit(` — matched by brace depth rather than "up to
 * the next `}`".
 *
 * A one-line snapshot fallback like `oldSnapshot: existing ?? {}` puts a second,
 * *closed* brace pair ahead of the real end of the object. A regex that stops at
 * the first `}` truncates there and never sees `kind`, which sits after `entity`
 * but can land before or after such a fallback depending on the call site — so
 * the miss is silent rather than merely early.
 */
function readBalancedBraces(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex, i + 1);
    }
  }
  return source.slice(openBraceIndex);
}

/**
 * Every `entity.kind` name reachable through `EntityAuditService.emit`.
 *
 * That method does not take an event-name string at all — it composes one from
 * two of its input's properties (`` `${input.entity}.${input.kind}` ``) — so no
 * regex over `.emit('literal')` call sites can ever see these. Every call site in
 * this codebase passes both `entity` and `kind` as plain string literals (never a
 * variable), which is what makes recovering the pair from source text reliable
 * rather than a best-effort guess.
 */
function collectEntityAuditEmits(sources: Map<string, string>): Set<string> {
  const emitted = new Set<string>();
  for (const source of sources.values()) {
    for (const match of source.matchAll(/entityAudit\.emit\(\s*\{/g)) {
      const openBrace = match.index! + match[0].length - 1;
      const args = readBalancedBraces(source, openBrace);
      const entity = args.match(/entity:\s*'([^']+)'/)?.[1];
      const kind = args.match(/kind:\s*'([^']+)'/)?.[1];
      if (entity && kind) emitted.add(`${entity}.${kind}`);
    }
  }
  return emitted;
}

/** Resolve `SomeEvents.KEY` references used in emit and @OnEvent positions. */
function collectConstantNames(sources: Map<string, string>) {
  const byMember = new Map<string, string>();
  for (const source of sources.values()) {
    // `KEY: 'some.event.name',` inside an `as const` map.
    for (const match of source.matchAll(
      /^\s{2}([A-Z][A-Z0-9_]*):\s*'([^']+)',/gm,
    )) {
      byMember.set(match[1], match[2]);
    }
  }
  return byMember;
}

function collectConstantEmits(
  sources: Map<string, string>,
  byMember: Map<string, string>,
) {
  const emitted = new Set<string>();
  for (const source of sources.values()) {
    for (const match of source.matchAll(
      // `.emit(OmniEvents.X)` and the outbox path, which publishes an event name
      // it is handed rather than emitting inline.
      /(?:\.emit(?:Async)?|saveAndPublishOutboxEvent)\(\s*(?:[^)]*?,\s*)?[A-Za-z]+Events\.([A-Z][A-Z0-9_]*)/g,
    )) {
      const resolved = byMember.get(match[1]);
      if (resolved) emitted.add(resolved);
    }
    // Dispatched through a variable: `eventType = OmniEvents.BOT_ENABLED` then
    // published further down. Counted as emitted — the name is reachable, which is
    // what this test is asking.
    for (const match of source.matchAll(
      /=\s*[A-Za-z]+Events\.([A-Z][A-Z0-9_]*)\s*;/g,
    )) {
      const resolved = byMember.get(match[1]);
      if (resolved) emitted.add(resolved);
    }
  }
  return emitted;
}

function collectConstantListeners(
  sources: Map<string, string>,
  byMember: Map<string, string>,
) {
  const listeners: Array<{ event: string; file: string }> = [];
  for (const [file, source] of sources) {
    for (const match of source.matchAll(
      /@OnEvent\(\s*[A-Za-z]+Events\.([A-Z][A-Z0-9_]*)/g,
    )) {
      const resolved = byMember.get(match[1]);
      if (resolved) listeners.push({ event: resolved, file });
    }
  }
  return listeners;
}

describe('event wiring', () => {
  const sources = new Map<string, string>();
  beforeAll(() => {
    for (const file of walk(SRC)) {
      if (file.endsWith('.spec.ts')) continue;
      sources.set(path.relative(SRC, file), fs.readFileSync(file, 'utf8'));
    }
  });

  it('should have an emitter for every @OnEvent listener', () => {
    const byMember = collectConstantNames(sources);
    const emitted = new Set([
      ...collectEmitted(sources),
      ...collectConstantEmits(sources, byMember),
      ...collectEntityAuditEmits(sources),
    ]);
    const listeners = [
      ...collectListeners(sources),
      ...collectConstantListeners(sources, byMember),
    ];

    const orphans = listeners
      .filter(
        ({ event }) =>
          inScope(event) && !emitted.has(event) && !EXTERNAL_EVENTS.has(event),
      )
      .map(({ event, file }) => `${event}  (listener in ${file})`);

    expect(orphans).toEqual([]);
  });

  it('should have a listener for every omni event that is emitted', () => {
    const byMember = collectConstantNames(sources);
    const listened = new Set(
      [
        ...collectListeners(sources),
        ...collectConstantListeners(sources, byMember),
      ].map(({ event }) => event),
    );
    const emitted = [
      ...collectEmitted(sources),
      ...collectConstantEmits(sources, byMember),
    ];

    // Scoped to `omni.*`: those are this module's own domain events, and an
    // omni event with no consumer is work thrown away — the Telegram shape.
    // Socket (`omni:`) and Redis (`socket:`) channel names are transports, not
    // domain events, and are consumed by the browser and by a `switch`.
    const unheard = emitted.filter(
      (event) => event.startsWith('omni.') && !listened.has(event),
    );

    expect(unheard).toEqual([]);
  });
});
