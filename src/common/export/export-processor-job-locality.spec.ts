import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sync as globSync } from 'glob';
import { AccountExportProcessor } from '../../accounts/export/account-export.processor';
import { ContactExportProcessor } from '../../contacts/contact-export.processor';
import { DealExportProcessor } from '../../deals/export/deal-export.processor';

/**
 * Export processors are singletons and the worker runs several jobs at once.
 * Any lookup map or resolved column list kept on the instance is shared between
 * tenants: job B clears and reloads it while job A is still formatting rows, so
 * A writes B's labels into A's file. Per-job state belongs in the config that
 * `beforeExport()` returns.
 */
describe('export processors keep per-job state out of the singleton', () => {
  const SRC = join(__dirname, '..', '..');

  it('should not declare per-job lookup state as instance fields', () => {
    const offenders: string[] = [];
    for (const file of globSync('**/*export.processor.ts', {
      cwd: SRC,
      absolute: true,
      ignore: ['**/*.spec.ts'],
    })) {
      const source = readFileSync(file, 'utf8');
      if (
        /private\s+(readonly\s+)?resolvedColumns\b/.test(source) ||
        /private\s+readonly\s+\w*Map\s*=\s*new Map/.test(source)
      ) {
        offenders.push(file.slice(SRC.length + 1).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('should isolate concurrent contact exports', async () => {
    const processor = Object.create(ContactExportProcessor.prototype) as any;
    processor.loadUserMap = (tenantId: string) =>
      Promise.resolve(new Map([['shared-id', `user-${tenantId}`]]));
    processor.loadLifecycleMaps = (tenantId: string) =>
      Promise.resolve({
        stageMap: new Map([['shared-id', `stage-${tenantId}`]]),
        statusMap: new Map([['shared-id', `status-${tenantId}`]]),
      });
    processor.customFields = undefined;

    const [a, b] = await Promise.all([
      processor.beforeExport({ tenantId: 'tenant-a' }),
      processor.beforeExport({ tenantId: 'tenant-b' }),
    ]);

    const owner = (cfg: any) =>
      cfg.columns.find((column: any) => column.path === 'ownerId');
    expect(owner(a).format('shared-id')).toBe('user-tenant-a');
    expect(owner(b).format('shared-id')).toBe('user-tenant-b');
  });

  it('should isolate concurrent account exports', async () => {
    const processor = Object.create(AccountExportProcessor.prototype) as any;
    const mapFor = (tenantId: string, prefix: string) =>
      Promise.resolve(new Map([['shared-id', `${prefix}-${tenantId}`]]));
    processor.loadUserMap = (tenantId: string) => mapFor(tenantId, 'user');
    processor.loadStatusMap = (tenantId: string) => mapFor(tenantId, 'status');
    processor.loadTypeMap = (tenantId: string) => mapFor(tenantId, 'type');
    processor.customFields = undefined;

    const [a, b] = await Promise.all([
      processor.beforeExport({ tenantId: 'tenant-a' }),
      processor.beforeExport({ tenantId: 'tenant-b' }),
    ]);

    const owner = (cfg: any) =>
      cfg.columns.find((column: any) => column.path === 'ownerId');
    expect(owner(a).format('shared-id')).toBe('user-tenant-a');
    expect(owner(b).format('shared-id')).toBe('user-tenant-b');
  });

  it('should isolate concurrent deal exports', async () => {
    const processor = Object.create(DealExportProcessor.prototype) as any;
    const mapFor = (tenantId: string, prefix: string) =>
      Promise.resolve(new Map([['shared-id', `${prefix}-${tenantId}`]]));
    processor.loadUserMap = (tenantId: string) => mapFor(tenantId, 'user');
    processor.loadStageMap = (tenantId: string) => mapFor(tenantId, 'stage');
    processor.loadSourceMap = (tenantId: string) => mapFor(tenantId, 'source');
    processor.loadAccountMap = (tenantId: string) =>
      mapFor(tenantId, 'account');
    processor.customFields = undefined;

    const [a, b] = await Promise.all([
      processor.beforeExport({ tenantId: 'tenant-a' }),
      processor.beforeExport({ tenantId: 'tenant-b' }),
    ]);

    const owner = (cfg: any) =>
      cfg.columns.find((column: any) => column.path === 'ownerId');
    expect(owner(a).format('shared-id')).toBe('user-tenant-a');
    expect(owner(b).format('shared-id')).toBe('user-tenant-b');
  });
});
