import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

/**
 * Every repository whose collection soft-deletes must exclude soft-deleted rows from
 * its by-id lookup.
 *
 * This is the guard for a defect that was invisible for as long as `remove()` issued
 * `deleteOne`: an unfiltered `findOne` returned null on its own, because the row was
 * gone. The moment deletion became a soft delete, the same unfiltered lookup started
 * SERVING deleted records — `GET /:id` answering 200 instead of 404, detail pages
 * rendering a deleted record as editable, and automation's `fetchRecord` resuming
 * delayed workflows against it, which is how a "wait 3 days, then email" step ends up
 * acting on something a user deleted three days ago.
 *
 * Five repositories had it at once (contacts, accounts, deals, tickets, tasks), so a
 * per-repository test would not have caught the pattern — the inventory is the point.
 * A source-level check, following the precedent of tenant-schema-inventory.spec.ts:
 * building each repository to inspect its compiled query would need a live model per
 * domain, and would still not tell you which repositories were missing.
 */

/** `deletedAt` in the schema means the collection models deletion as a timestamp. */
const schemaSoftDeletes = (source: string): boolean =>
  /\bdeletedAt\b/.test(source);

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.repository\.ts$/.test(entry.name) && !/\.spec\./.test(entry.name)
      ? [full]
      : [];
  });

/**
 * Repositories deliberately exempt. Each entry is a reviewed decision: a by-id lookup
 * that must be able to see archived rows.
 */
const REVIEWED_EXEMPTIONS = new Set<string>([
  // Notes are only ever read through their contact, whose own lookup is filtered, and
  // the note repository's list query already excludes deleted rows.
  'notes/infrastructure/persistence/document/repositories/note.repository.ts',
]);

/**
 * Repositories whose list query legitimately does not filter `deletedAt`. Separate from
 * the findOne list because the reasons differ.
 */
const LIST_EXEMPTIONS = new Set<string>([
  // These build the list filter in a helper (`buildListWhere`/`buildScopedWhere`),
  // which the extractor below cannot see through. Each DOES filter `deletedAt` —
  // verified by reading them — and carries a comment saying so. Teaching the
  // extractor to follow one level of indirection would make it a parser; naming
  // the files is honest about the limit.
  'accounts/infrastructure/persistence/document/repositories/account.repository.ts',
  'contacts/infrastructure/persistence/document/repositories/contact.repository.ts',
  // `buildScopedWhere` (shared by findManyWithPagination and the keyset sibling
  // findManyByCursor) sets `deletedAt: null` — see the comment on that method.
  'deals/infrastructure/persistence/document/repositories/deal.repository.ts',

  // Users HARD-delete: UserRepository overrides remove() with deleteOne, so no row ever
  // carries a deletedAt for a list to hide. Recorded as an exemption rather than fixed
  // because the schema DOES declare the field, and that mismatch is the open finding
  // written up in soft-delete-recoverability.spec.ts — a deleted user is destroyed
  // while contacts, deals and tickets keep pointing at its id. If user deletion ever
  // becomes soft, this entry is the reminder that the list needs the filter.
  'users/infrastructure/persistence/document/repositories/user.repository.ts',
]);

/** The `findOne(...)` body, up to the first `.exec()` — where the filter is built. */
const findOneBody = (source: string): string | null => {
  const start = source.search(/async findOne\s*\(/);
  if (start === -1) return null;
  const exec = source.indexOf('.exec()', start);
  return source.slice(start, exec === -1 ? start + 1200 : exec);
};

/**
 * The `findManyWithPagination(...)` body, up to the `.exec()` that runs it.
 *
 * The LIST query, and the reason this file grew a second half. The original inventory
 * checked `findOne` only, so it certified as clean two repositories whose list query
 * never filtered `deletedAt` — deals and tickets, which listed deleted records for as
 * long as soft delete existed. Accounts had the same defect and was found by hand in a
 * later pass, then written up as "the only list query in the CRM" doing it. It was not,
 * and a guard that inspects one read path per repository will keep producing that
 * sentence.
 */
/**
 * The body of a private `buildX()` helper the list query delegates to.
 *
 * A list that builds its predicates in a shared builder — so the export path
 * cannot disagree with the screen — is the shape we want, and reporting that
 * indirection as a missing `deletedAt` would push repositories back towards a
 * second copy of the filter. Following one level keeps the assertion honest: the
 * builder's body is searched, so deleting the guard from it still turns this red.
 */
const methodBody = (source: string, from: number): string => {
  const open = source.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      // Braces are matched rather than a fixed character budget: a budget spills
      // into the *next* method, and the neighbouring `buildExportFilter` also
      // says `deletedAt: null` — so the assertion would pass on the neighbour's
      // guard and never notice this one being deleted.
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
};

const delegatedBuilders = (source: string, body: string): string =>
  [...body.matchAll(/this\.(build\w+)\s*\(/g)]
    .map(([, name]) => {
      const start = source.search(new RegExp(`(?:private\\s+)?${name}\\s*\\(`));
      return start === -1 ? '' : methodBody(source, start);
    })
    .join('\n');

const listBody = (source: string): string | null => {
  const start = source.search(/async findManyWithPagination\s*\(/);
  if (start === -1) return null;
  const exec = source.indexOf('.exec()', start);
  const body = source.slice(start, exec === -1 ? start + 4000 : exec);
  return `${body}\n${delegatedBuilders(source, body)}`;
};

describe('soft-delete read inventory', () => {
  const repositories = walk(SRC).map((file) => ({
    relative: path.relative(SRC, file).replaceAll('\\', '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

  it('should find repositories to inspect', () => {
    // A silent zero here would make every assertion below vacuously true.
    expect(repositories.length).toBeGreaterThan(5);
  });

  it('should exclude soft-deleted rows from every soft-deleting findOne', () => {
    const violations = repositories
      .filter(({ relative, source }) => {
        if (REVIEWED_EXEMPTIONS.has(relative)) return false;
        if (!schemaSoftDeletes(source)) return false;
        const body = findOneBody(source);
        // No `findOne` at all is fine — nothing to leak.
        if (body === null) return false;
        return !/\bdeletedAt\b/.test(body);
      })
      .map(({ relative }) => relative);

    expect(violations).toEqual([]);
  });

  it('should let a caller opt out explicitly rather than hard-coding the filter', () => {
    // Merge and restore paths legitimately need to load an archived row. The agreed
    // shape is `filter.deletedAt !== undefined ? filter : { ...filter, deletedAt: null }`
    // — a hard-coded `deletedAt: null` would make those paths impossible and push
    // callers into bypassing the repository entirely.
    const softDeleting = repositories.filter(
      ({ relative, source }) =>
        !REVIEWED_EXEMPTIONS.has(relative) &&
        schemaSoftDeletes(source) &&
        findOneBody(source)?.includes('deletedAt'),
    );

    expect(softDeleting.length).toBeGreaterThan(0);
    for (const { relative, source } of softDeleting) {
      expect(findOneBody(source)).toContain('deletedAt !== undefined');
      expect(relative).toBeTruthy();
    }
  });

  it('should exclude soft-deleted rows from every soft-deleting LIST query', () => {
    // The half that was missing. A deleted record showing up in a list view is the most
    // visible form of this bug — a user deletes something, the row stays on screen, and
    // clicking it now 404s because `findOne` (which WAS guarded) refuses to serve it.
    const violations = repositories
      .filter(({ relative, source }) => {
        if (LIST_EXEMPTIONS.has(relative)) return false;
        if (!schemaSoftDeletes(source)) return false;
        const body = listBody(source);
        if (body === null) return false;
        return !/\bdeletedAt\b/.test(body);
      })
      .map(({ relative }) => relative);

    expect(violations).toEqual([]);
  });

  it('should keep every list exemption real', () => {
    const known = new Set(repositories.map((r) => r.relative));
    for (const exemption of LIST_EXEMPTIONS) {
      expect(known).toContain(exemption);
    }
  });

  it('should keep every exemption real (no stale allowlist entries)', () => {
    const known = new Set(repositories.map((r) => r.relative));
    for (const exemption of REVIEWED_EXEMPTIONS) {
      expect(known).toContain(exemption);
    }
  });
});
