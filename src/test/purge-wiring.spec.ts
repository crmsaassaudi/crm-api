import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

/**
 * The purge services have to be REGISTERED, not merely written.
 *
 * A `@Cron` in a class Nest never instantiates never fires, and nothing reports that: the
 * file exists, its unit tests pass, and the job silently does not run. The same shape as
 * the four crons that failed on their first query — a job that appears to exist.
 *
 * Static, deliberately: booting the module graph needs Mongo, Redis and BullMQ, and this
 * question does not.
 */
const REGISTRATIONS = [
  {
    service: 'ContactPurgeService',
    module: 'contacts/contacts.module.ts',
  },
  { service: 'AccountPurgeService', module: 'accounts/accounts.module.ts' },
  { service: 'DealPurgeService', module: 'deals/deals.module.ts' },
  { service: 'TicketPurgeService', module: 'tickets/tickets.module.ts' },
  { service: 'TaskPurgeService', module: 'tasks/tasks.module.ts' },
] as const;

const read = (relative: string) =>
  fs.readFileSync(path.join(SRC, relative), 'utf8');

describe('retention purge wiring', () => {
  it.each(REGISTRATIONS)(
    '$service should be provided by its module',
    ({ service, module }) => {
      const source = read(module);
      expect(source).toContain(`import { ${service} }`);
      expect(source).toContain(`      ${service},`);
    },
  );

  it.each(REGISTRATIONS)(
    '$service should be gated on the worker runtime',
    ({ service, module }) => {
      const source = read(module);
      // Purges are destructive and cluster-singleton. Scheduling them in every API
      // replica too would make the Redis lock load-bearing for correctness rather than a
      // safety net.
      const workerBlock = source.slice(
        source.indexOf('isWorkerRuntime()'),
        source.indexOf('@Module('),
      );
      expect(workerBlock).toContain(service);
    },
  );

  it('should register the shared runner globally', () => {
    const app = read('app.module.ts');
    expect(app).toContain('ReferencesModule');
  });

  it('should give every purge a distinct cron minute', () => {
    // Overlapping passes `updateMany` the same tickets and tasks for no benefit, and a
    // single Redis key per domain does not prevent two DIFFERENT domains colliding.
    const crons = REGISTRATIONS.map(({ service, module }) => {
      const dir = module.split('/')[0];
      const file = `${dir}/${service
        .replace(/([A-Z])/g, (m, c: string) => `-${c.toLowerCase()}`)
        .replace(/^-/, '')
        .replace('-purge-service', '-purge.service')}.ts`;
      const source = read(file);
      const match = source.match(/@Cron\(([^)]*)\)/);
      return { service, cron: match?.[1] ?? 'MISSING' };
    });

    for (const entry of crons) {
      expect(entry.cron).not.toBe('MISSING');
    }
    const expressions = crons.map((c) => c.cron);
    expect(new Set(expressions).size).toBe(expressions.length);
  });
});
