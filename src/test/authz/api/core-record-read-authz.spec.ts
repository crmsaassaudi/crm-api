import { AccountsController } from '../../../accounts/accounts.controller';
import { ContactsController } from '../../../contacts/contacts.controller';
import { DealsController } from '../../../deals/deals.controller';
import { TasksController } from '../../../tasks/tasks.controller';
import { TicketsController } from '../../../tickets/tickets.controller';
import {
  ACL_METADATA_KEY,
  AclMetadata,
} from '../../../common/permissions/use-acl.decorator';
import { LOAD_RESOURCE_METADATA_KEY } from '../../../common/permissions/load-resource.decorator';
import { ResourceLoaderRegistry } from '../../../common/permissions/resource-loader.registry';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

describe('core record read authorization wiring', () => {
  const routes: Array<{
    controller: { prototype: { findOne: (...args: any[]) => unknown } };
    resource: string;
  }> = [
    { controller: ContactsController, resource: 'contacts' },
    { controller: AccountsController, resource: 'accounts' },
    { controller: DealsController, resource: 'deals' },
    { controller: TicketsController, resource: 'tickets' },
    { controller: TasksController, resource: 'tasks' },
  ];

  it.each(routes)(
    'should enforce object ACL and ABAC for $resource detail reads',
    ({ controller, resource }) => {
      const handler = controller.prototype.findOne as Function;
      const acl = Reflect.getMetadata(ACL_METADATA_KEY, handler) as AclMetadata;
      const loader = Reflect.getMetadata(
        LOAD_RESOURCE_METADATA_KEY,
        handler,
      ) as string;

      expect(acl).toEqual({ action: 'view', resource, idParam: 'id' });
      expect(loader).toBe(resource);
      expect(ResourceLoaderRegistry.supportedKeys).toContain(loader);
    },
  );

  it('should enforce the parent Deal policy when listing tickets by deal', () => {
    const handler = TicketsController.prototype.findByDeal;
    expect(Reflect.getMetadata(ACL_METADATA_KEY, handler)).toEqual({
      action: 'view',
      resource: 'deals',
      idParam: 'dealId',
    });
    expect(Reflect.getMetadata(LOAD_RESOURCE_METADATA_KEY, handler)).toBe(
      'deals',
    );
  });

  it('should require parent-record ACL and loading on every core :id read', () => {
    const controllers = [
      ContactsController,
      AccountsController,
      DealsController,
      TicketsController,
      TasksController,
    ];
    const missing: string[] = [];

    for (const controller of controllers) {
      for (const handler of Object.getOwnPropertyNames(controller.prototype)) {
        if (handler === 'constructor') continue;
        const method = (controller.prototype as any)[handler];
        const path = Reflect.getMetadata(PATH_METADATA, method);
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, method);
        if (
          typeof path !== 'string' ||
          !path.startsWith(':id') ||
          requestMethod !== RequestMethod.GET
        ) {
          continue;
        }
        if (
          !Reflect.getMetadata(ACL_METADATA_KEY, method) ||
          !Reflect.getMetadata(LOAD_RESOURCE_METADATA_KEY, method)
        ) {
          missing.push(`${controller.name}.${handler} [${path}]`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('core record mutation authorization wiring', () => {
  const routes: Array<{
    controller: { prototype: Record<string, Function> };
    handler: string;
    action: string;
    resource: string;
  }> = [
    {
      controller: ContactsController as any,
      handler: 'mergeContacts',
      action: 'edit',
      resource: 'contacts',
    },
    {
      controller: ContactsController as any,
      handler: 'unmaskFields',
      action: 'unmask',
      resource: 'contacts',
    },
    {
      controller: ContactsController as any,
      handler: 'createNote',
      action: 'edit',
      resource: 'contacts',
    },
    {
      controller: ContactsController as any,
      handler: 'deleteContactNote',
      action: 'delete',
      resource: 'contacts',
    },
    {
      controller: ContactsController as any,
      handler: 'changeStage',
      action: 'edit',
      resource: 'contacts',
    },
    {
      controller: ContactsController as any,
      handler: 'mergeIdentity',
      action: 'edit',
      resource: 'contacts',
    },
    {
      controller: DealsController as any,
      handler: 'createActivity',
      action: 'edit',
      resource: 'deals',
    },
    ...[
      'mergeTickets',
      'pauseSla',
      'resumeSla',
      'linkDeal',
      'unlinkDeal',
      'setParent',
      'removeParent',
    ].map((handler) => ({
      controller: TicketsController as any,
      handler,
      action: 'edit',
      resource: 'tickets',
    })),
  ];

  it.each(routes)(
    'should enforce $action ACL/ABAC on $resource.$handler',
    ({ controller, handler, action, resource }) => {
      const method = controller.prototype[handler];
      expect(Reflect.getMetadata(ACL_METADATA_KEY, method)).toEqual({
        action,
        resource,
        idParam: 'id',
      });
      expect(Reflect.getMetadata(LOAD_RESOURCE_METADATA_KEY, method)).toBe(
        resource,
      );
      expect(ResourceLoaderRegistry.supportedKeys).toContain(resource);
    },
  );

  it('should require ACL and a resource loader on every core :id mutation', () => {
    const controllers = [
      ContactsController,
      AccountsController,
      DealsController,
      TicketsController,
      TasksController,
    ];
    const missing: string[] = [];

    for (const controller of controllers) {
      for (const handler of Object.getOwnPropertyNames(controller.prototype)) {
        if (handler === 'constructor') continue;
        const method = (controller.prototype as any)[handler];
        const path = Reflect.getMetadata(PATH_METADATA, method);
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, method);
        if (
          typeof path !== 'string' ||
          !path.startsWith(':id') ||
          requestMethod === RequestMethod.GET
        ) {
          continue;
        }
        if (
          !Reflect.getMetadata(ACL_METADATA_KEY, method) ||
          !Reflect.getMetadata(LOAD_RESOURCE_METADATA_KEY, method)
        ) {
          missing.push(`${controller.name}.${handler} [${path}]`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
