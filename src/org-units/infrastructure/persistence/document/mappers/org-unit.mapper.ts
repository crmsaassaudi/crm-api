import { OrgUnit } from '../../../../domain/org-unit';
import { OrgUnitSchemaClass } from '../entities/org-unit.schema';

export class OrgUnitMapper {
  static toDomain(raw: any): OrgUnit {
    const entity = new OrgUnit();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.name = raw.name;
    entity.code = raw.code ?? null;
    entity.description = raw.description ?? null;
    entity.parentId = raw.parentId ? raw.parentId.toString() : null;
    entity.path = raw.path;
    entity.depth = raw.depth ?? 0;
    entity.managerId = raw.managerId ? raw.managerId.toString() : null;
    entity.isActive = raw.isActive;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }

  /**
   * `path` and `depth` are deliberately absent from the writable set: they are
   * derived from `parentId` and maintained only by OrgUnitsService. Accepting
   * them from a caller would let a request place a unit anywhere in the tree —
   * i.e. grant itself a subtree scope — without touching parentId at all.
   */
  static toPersistence(
    domain: Partial<OrgUnit>,
  ): Partial<OrgUnitSchemaClass> & Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    if (domain.tenantId !== undefined) doc.tenantId = domain.tenantId;
    if (domain.name !== undefined) doc.name = domain.name;
    if (domain.code !== undefined) doc.code = domain.code;
    if (domain.description !== undefined) doc.description = domain.description;
    if (domain.parentId !== undefined) doc.parentId = domain.parentId;
    if (domain.managerId !== undefined) doc.managerId = domain.managerId;
    if (domain.isActive !== undefined) doc.isActive = domain.isActive;
    return doc as Partial<OrgUnitSchemaClass> & Record<string, unknown>;
  }
}
