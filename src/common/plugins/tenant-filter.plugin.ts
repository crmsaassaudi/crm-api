import { Schema } from 'mongoose';
import { ClsService } from 'nestjs-cls';

/**
 * Global Mongoose Plugin for automatic tenant filtering
 * Automatically adds tenant filter to queries on schemas with 'tenants' field
 */
export function tenantFilterPlugin(schema: Schema, options?: { field?: string }) {
    const tenantField = options?.field || 'tenants.tenant';

    // Add pre-find hooks to automatically filter by tenant
    schema.pre('find', function () {
        applyTenantFilter(this, tenantField);
    });

    schema.pre('findOne', function () {
        applyTenantFilter(this, tenantField);
    });

    schema.pre('findOneAndUpdate', function () {
        applyTenantFilter(this, tenantField);
    });

    schema.pre('updateMany', function () {
        applyTenantFilter(this, tenantField);
    });

    schema.pre('deleteMany', function () {
        applyTenantFilter(this, tenantField);
    });

    schema.pre('countDocuments', function () {
        applyTenantFilter(this, tenantField);
    });
}

/**
 * Apply tenant filter to query if activeTenantId exists in CLS
 */
function applyTenantFilter(query: any, tenantField: string) {
    // Access CLS from global context (set by middleware)
    const cls = (global as any).__cls_service as ClsService;

    if (!cls) {
        return; // CLS not available, skip filtering
    }

    const activeTenantId = cls.get('activeTenantId') || cls.get('tenantId');

    if (activeTenantId && activeTenantId !== '00000000-0000-0000-0000-000000000000') {
        const currentFilter = query.getFilter();

        // Only add filter if not already present
        if (!currentFilter[tenantField]) {
            query.where(tenantField).equals(activeTenantId);
        }
    }
}

/**
 * Alternative: Schema-specific tenant filter
 * Use this for schemas that need custom tenant filtering logic
 */
export function createTenantFilter(cls: ClsService, field: string = 'tenants.tenant') {
    return function (schema: Schema) {
        schema.pre(['find', 'findOne', 'findOneAndUpdate', 'updateMany', 'deleteMany', 'countDocuments'], function () {
            const activeTenantId = cls.get('activeTenantId') || cls.get('tenantId');

            if (activeTenantId && activeTenantId !== '00000000-0000-0000-0000-000000000000') {
                const currentFilter = this.getFilter();

                if (!currentFilter[field]) {
                    this.where(field).equals(activeTenantId);
                }
            }
        });
    };
}
