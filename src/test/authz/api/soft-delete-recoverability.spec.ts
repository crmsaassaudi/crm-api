import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

/**
 * Every soft-deleting domain must offer a way back out.
 *
 * The sibling of `soft-delete-read-inventory.spec.ts`, guarding the other half of the
 * same rollout. Soft delete arrived on six collections in one change — contacts,
 * accounts, deals, tickets, tasks, notes — and only contacts got `recycle-bin` and
 * `restore`. For the other five the outcome was strictly worse than the hard delete it
 * replaced:
 *
 *   - the record stopped being visible anywhere (correct, and the point);
 *   - it stopped being recoverable through any API (a regression);
 *   - and outside contacts there is no purge job, so the row stays in the database
 *     forever (a slow accumulation nobody would notice).
 *
 * Soft delete earns its complexity by being reversible. A per-domain opt-in is how five
 * of six domains ended up paying the cost and collecting none of the benefit, which is
 * why `findDeleted` now lives on `BaseDocumentRepository` alongside `remove()` and
 * `restore()` — and why this inventory exists rather than a test per domain.
 */

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.controller\.ts$/.test(entry.name) && !/\.spec\./.test(entry.name)
      ? [full]
      : [];
  });

/**
 * The first-class objects: each has its own list view, its own DELETE route, and a user
 * who can lose work by mis-clicking it.
 *
 * Hard-coded rather than derived from the schemas on purpose. Deriving would sweep in
 * every child and infrastructure collection that happens to declare `deletedAt`, and the
 * assertion would then be about what the codebase does rather than about what a user can
 * recover.
 */
const FIRST_CLASS_DOMAINS = [
  { controller: 'contacts/contacts.controller.ts', resource: 'contacts' },
  { controller: 'accounts/accounts.controller.ts', resource: 'accounts' },
  { controller: 'deals/deals.controller.ts', resource: 'deals' },
  { controller: 'tickets/tickets.controller.ts', resource: 'tickets' },
  { controller: 'tasks/tasks.controller.ts', resource: 'tasks' },
] as const;

/**
 * Soft-deleting collections deliberately WITHOUT their own recycle bin. Each entry is a
 * reviewed decision, not an oversight.
 */
const REVIEWED_NO_BIN: Record<string, string> = {
  'notes/notes.controller.ts':
    'A note is a child of its contact and has no standalone list view; a bin of ' +
    'orphaned note bodies would be unreadable. Deleting the parent contact cascades ' +
    'and restoring it brings the notes back with it.',

  'users/users.controller.ts':
    'FINDING, not a clean exemption: UserSchemaClass declares `deletedAt` but ' +
    'UserRepository overrides remove() with deleteOne, so a deleted user is ' +
    'DESTROYED — while contacts, deals and tickets keep pointing at its id through ' +
    'ownerId/createdById/updatedById. Left as-is here because making user deletion ' +
    'soft is not a recycle-bin change: it has to be decided together with the ' +
    'identity provider (a Keycloak user that still exists, a login that must stop ' +
    'working, an email that must be reusable). Recorded so it is a decision rather ' +
    'than an omission.',

  'contacts/segments/contact-segments.controller.ts':
    'A segment is a definition, not a record: it holds a condition tree or a list ' +
    'of ids, nothing references it, and no history hangs off it. It HARD-deletes — ' +
    'ContactSegmentSchemaClass declares no `deletedAt` at all. This entry exists ' +
    'only because the detector reads the whole feature folder for the signal, and ' +
    'the folder contains contact.schema.ts, which does soft-delete.',

  'campaigns/campaigns.controller.ts':
    'A campaign soft-deletes for referential reasons, not archival ones: every ' +
    'campaign_recipients row is a compliance record ("we messaged this person on ' +
    'this date") and is never deleted, so destroying the campaign would leave all ' +
    'of them pointing at nothing. Delete here is therefore an archive — the ' +
    'definition and its whole ledger stay intact and queryable. RECORDED GAP, not ' +
    'a clean exemption: there is no restore route yet, so an accidental delete ' +
    'currently needs a support action. A bin belongs with a retention purge, and ' +
    'campaigns have neither yet.',

  'channels/channels.controller.ts':
    'Channel config soft-deletes for a different reason than CRM records: the ' +
    'partial unique index on (tenantId, providerType, name) is scoped to ' +
    'deletedAt:null, so archiving a config frees its name. That makes a naive ' +
    'restore unsound — the name may already belong to a config created since — and ' +
    'a channel is re-established through the provider connect flow anyway, which is ' +
    'the supported recovery path.',
};

const read = (relative: string): string =>
  fs.readFileSync(path.join(SRC, relative), 'utf8');

describe('soft-delete recoverability inventory', () => {
  it.each(FIRST_CLASS_DOMAINS)(
    '$resource should expose a recycle bin listing',
    ({ controller }) => {
      const source = read(controller);
      expect(source).toMatch(/@Get\('recycle-bin'\)/);
    },
  );

  it.each(FIRST_CLASS_DOMAINS)(
    '$resource should expose a restore route',
    ({ controller }) => {
      const source = read(controller);
      expect(source).toMatch(/@Post\(':id\/restore'\)/);
    },
  );

  it.each(FIRST_CLASS_DOMAINS)(
    '$resource restore should require `delete`, not `edit`',
    ({ controller, resource }) => {
      const source = read(controller);
      const at = source.indexOf(`@Post(':id/restore')`);
      expect(at).toBeGreaterThan(-1);
      // Slice to the handler signature rather than a fixed window: these decorators
      // are interleaved with explanatory comments (contacts has five lines of them
      // between `@RequirePermission` and `@UseAcl`), and a fixed window silently
      // truncated past the decorator it was meant to find.
      const handler = source.indexOf('restore(', at);
      const decorators = source.slice(at, handler === -1 ? at + 600 : handler);
      // Restoring re-exposes a record, so it takes the same capability that removed
      // it. Gating it on `edit` would let someone who cannot delete a record undelete
      // one — and a restore is how a record someone deliberately archived comes back.
      expect(decorators).toContain(
        `@RequirePermission('delete', '${resource}')`,
      );
      expect(decorators).toContain(`@UseAcl('delete', '${resource}')`);
      // Record-level: you may only bring back a record you could have seen.
      expect(decorators).toContain(`@LoadResource('${resource}')`);
    },
  );

  it.each(FIRST_CLASS_DOMAINS)(
    "$resource should declare 'recycle-bin' before any parameterised GET",
    ({ controller }) => {
      const source = read(controller);
      const bin = source.indexOf(`@Get('recycle-bin')`);
      const parameterised = source.search(/@Get\(':id'\)/);
      // Nest matches in declaration order, so a `:id` GET declared first swallows
      // `/recycle-bin` and the bin returns a 404-or-worse: the handler for `:id`
      // running with the literal string 'recycle-bin' as an id.
      if (parameterised !== -1) {
        expect(bin).toBeLessThan(parameterised);
      }
    },
  );

  it.each(FIRST_CLASS_DOMAINS)(
    '$resource should have a retention purge, not just a bin',
    ({ resource }) => {
      // The other half of soft delete. A bin without a purge means the row is restorable
      // forever and never actually leaves — which was the state of all five domains until
      // the purge services landed, and makes a GDPR erasure request impossible to honour.
      const singular = resource.replace(/s$/, '');
      const candidates = [
        `${resource}/${singular}-purge.service.ts`,
        `${resource}/${singular}s-purge.service.ts`,
        `${resource}/${singular}.purge.service.ts`,
      ];
      const found = candidates.some((relative) =>
        fs.existsSync(path.join(SRC, relative)),
      );
      expect({ resource, hasPurgeService: found }).toEqual({
        resource,
        hasPurgeService: true,
      });
    },
  );

  it('should keep every no-bin exemption pointing at a controller that exists', () => {
    for (const relative of Object.keys(REVIEWED_NO_BIN)) {
      expect(fs.existsSync(path.join(SRC, relative))).toBe(true);
    }
  });

  it('should not let a soft-deleting controller quietly skip both the bin and the exemption list', () => {
    // The regression gate. A new DELETE route on a `deletedAt` collection either gets a
    // recycle bin or an explicit, justified exemption — the failure mode this whole
    // spec exists for is the third option, silence.
    const exempt = new Set<string>(Object.keys(REVIEWED_NO_BIN));

    const unaccounted = walk(SRC)
      .map((file) => ({
        relative: path.relative(SRC, file).replaceAll('\\', '/'),
        source: fs.readFileSync(file, 'utf8'),
      }))
      // A controller that deletes a CRM record by id, on a domain that soft-deletes.
      .filter(({ relative, source }) => {
        if (exempt.has(relative)) return false;
        // Self-crediting: any controller that offers a restore route passes, whether
        // or not it is one of the five above. Files and folders had their own restore
        // long before this inventory existed, and an allowlist keyed on names would
        // have reported them as gaps and invited an exemption entry for work already
        // done.
        if (/@Post\(':id\/restore'\)/.test(source)) return false;
        if (!/@Delete\(':id'\)/.test(source)) return false;
        // The `deletedAt` signal has to come from the domain's own schema, not the
        // controller — read the sibling schema files under the same feature folder.
        const feature = relative.split('/')[0];
        const featureDir = path.join(SRC, feature);
        if (!fs.existsSync(featureDir)) return false;
        const schemas = walk2(featureDir).filter((f) =>
          /\.schema\.ts$/.test(f),
        );
        return schemas.some((f) =>
          /\bdeletedAt\b/.test(fs.readFileSync(f, 'utf8')),
        );
      })
      .map(({ relative }) => relative);

    expect({ unaccounted }).toEqual({ unaccounted: [] });
  });
});

/** Every file under a directory, recursively. */
function walk2(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk2(full) : [full];
  });
}
