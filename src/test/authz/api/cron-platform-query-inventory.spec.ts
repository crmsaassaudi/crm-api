import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

/**
 * Every model query a cron issues must declare `isPlatformQuery`.
 *
 * `tenantFilterPlugin` THROWS when CLS carries no tenant — deliberately, so a lost
 * request context can never silently become a cross-tenant read. A cron has no request
 * context, so it has to say so.
 *
 * Four nightly jobs did not, and each failed on its first query while reporting itself as
 * "skipped" at debug level:
 *
 *   - the contact retention purge (so nothing was ever purged, and GDPR erasure never
 *     completed);
 *   - the nightly contact rescore (every contact kept a score of 0);
 *   - the identity drift check (the thing built to notice silence, silent);
 *   - the daily metrics rollup (and because `canServeFromRollup` fails closed, every
 *     report fell back to the live query it was meant to replace — no error, just the
 *     old cost).
 *
 * All four were unit-tested against mocked models, which is precisely why none of it
 * surfaced: a mock has no plugin. This inventory is the check those unit tests could not
 * be, and `test/cron-platform-query.integration.spec.ts` proves the underlying behaviour
 * against a real database.
 */

/** Operations `tenantFilterPlugin` hooks. Anything else is not gated. */
const HOOKED_OPERATIONS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndRemove',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'count',
  'countDocuments',
  'distinct',
  'aggregate',
];

/**
 * Cron-file queries that legitimately carry no `isPlatformQuery`. Each entry is a
 * reviewed decision with the reason it is safe.
 */
const REVIEWED: Record<string, string> = {
  'tasks/recurring-task.service.ts':
    'Every model call sits inside runWithTenantContext(cls, tenantId, …), so CLS DOES ' +
    'carry a tenant and the plugin scopes the query correctly. Per-tenant context is ' +
    'the better pattern where the job iterates tenants anyway — the platform flag is ' +
    'for reads that must span them.',

  'omni-inbound/aggregate/outbox-publisher.service.ts':
    'OutboxEventSchemaClass does not install tenantFilterPlugin, so no hook runs and ' +
    'nothing can throw. Listed rather than ignored because the reason is a property of ' +
    'the SCHEMA, not of this file — if the plugin is ever added there, this entry is ' +
    'the reminder that these four queries need the flag.',
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.includes('.spec.')
      ? [full]
      : [];
  });

/**
 * The full statement starting at `from` — to the `;` at paren/bracket depth zero.
 *
 * A naive "slice to the first `;`" is wrong for exactly the queries that matter: an
 * aggregation pipeline contains semicolon-free objects spanning dozens of lines, and the
 * option that declares the query comes AFTER them. My first pass at this check used the
 * naive version and reported the rollup as unfixed after I had fixed it.
 */
function statementAt(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if (char === ';' && depth <= 0) return source.slice(from, i);
  }
  return source.slice(from, from + 4000);
}

interface Finding {
  file: string;
  call: string;
  line: number;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  const pattern = new RegExp(
    `this\\.(\\w*[Mm]odel)\\s*\\.\\s*(${HOOKED_OPERATIONS.join('|')})\\s*\\(`,
    'g',
  );

  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/@Cron\(/.test(source)) continue;

    const relative = path.relative(SRC, file).replaceAll('\\', '/');
    if (relative in REVIEWED) continue;

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const statement = statementAt(source, match.index);
      if (statement.includes('isPlatformQuery')) continue;
      findings.push({
        file: relative,
        call: `${match[1]}.${match[2]}`,
        line: source.slice(0, match.index).split('\n').length,
      });
    }
  }

  return findings;
}

describe('cron platform-query inventory', () => {
  it('should find cron services to check', () => {
    // Guards against the discovery itself breaking and turning this into a test that
    // asserts nothing — the failure mode of every source-scanning check.
    const cronFiles = walk(SRC).filter((file) =>
      /@Cron\(/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(cronFiles.length).toBeGreaterThan(8);
  });

  it('should keep every reviewed exemption pointing at a file that still exists', () => {
    for (const relative of Object.keys(REVIEWED)) {
      expect(fs.existsSync(path.join(SRC, relative))).toBe(true);
    }
  });

  it('should keep every reviewed exemption still a cron file', () => {
    // If the @Cron moves out, the exemption is stale and hides nothing — but it would
    // still silently absolve whatever query remains.
    for (const relative of Object.keys(REVIEWED)) {
      const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
      expect(source).toMatch(/@Cron\(/);
    }
  });

  it('should not let a cron query the database without declaring itself', () => {
    const findings = scan();
    expect({ undeclared: findings }).toEqual({ undeclared: [] });
  });
});
