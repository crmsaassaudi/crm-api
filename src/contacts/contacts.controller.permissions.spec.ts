import 'reflect-metadata';
import { PERMISSION_RULE_METADATA } from '../common/permissions/permission.decorator';
import { ContactsController } from './contacts.controller';

describe('ContactsController permission contract', () => {
  it.each([
    'uploadImportFile',
    'startImport',
    'getImportStatus',
    'listImportJobs',
    'getImportJobDetail',
    'downloadImportReport',
  ] as const)(
    'should require the dedicated contacts:import capability for %s',
    (method) => {
      const handler = ContactsController.prototype[method];

      expect(Reflect.getMetadata(PERMISSION_RULE_METADATA, handler)).toEqual({
        action: 'import',
        resource: 'contacts',
      });
    },
  );

  it('should not conflate ordinary contact creation with bulk import', () => {
    expect(
      Reflect.getMetadata(
        PERMISSION_RULE_METADATA,
        ContactsController.prototype.create,
      ),
    ).toEqual({ action: 'create', resource: 'contacts' });
  });
});
