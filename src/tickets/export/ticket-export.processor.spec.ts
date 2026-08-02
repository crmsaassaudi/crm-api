import 'reflect-metadata';
import { TicketExportProcessor } from './ticket-export.processor';

describe('TicketExportProcessor job-local configuration', () => {
  it('should keep concurrent tenant lookup maps isolated', async () => {
    const processor = Object.create(TicketExportProcessor.prototype) as any;
    const mapFor = (tenantId: string, prefix: string) =>
      Promise.resolve(new Map([['shared-id', `${prefix}-${tenantId}`]]));
    processor.loadUserMap = (tenantId: string) => mapFor(tenantId, 'user');
    processor.loadStatusMap = (tenantId: string) => mapFor(tenantId, 'status');
    processor.loadTypeMap = (tenantId: string) => mapFor(tenantId, 'type');
    processor.loadSourceMap = (tenantId: string) => mapFor(tenantId, 'source');
    processor.loadGroupMap = (tenantId: string) => mapFor(tenantId, 'group');
    processor.customFields = undefined;

    const [tenantA, tenantB] = await Promise.all([
      processor.beforeExport({ tenantId: 'tenant-a' }),
      processor.beforeExport({ tenantId: 'tenant-b' }),
    ]);
    const ownerA = tenantA.columns.find(
      (column: any) => column.path === 'ownerId',
    );
    const ownerB = tenantB.columns.find(
      (column: any) => column.path === 'ownerId',
    );

    expect(ownerA.format('shared-id')).toBe('user-tenant-a');
    expect(ownerB.format('shared-id')).toBe('user-tenant-b');
    expect(processor).not.toHaveProperty('resolvedColumns');
  });
});
