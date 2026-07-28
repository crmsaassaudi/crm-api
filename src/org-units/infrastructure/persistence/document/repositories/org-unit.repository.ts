import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  OrgUnitSchemaClass,
  OrgUnitSchemaDocument,
} from '../entities/org-unit.schema';
import { OrgUnit } from '../../../../domain/org-unit';
import { OrgUnitMapper } from '../mappers/org-unit.mapper';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class OrgUnitRepository {
  constructor(
    @InjectModel(OrgUnitSchemaClass.name)
    private readonly model: Model<OrgUnitSchemaDocument>,
  ) {}

  async findAll(
    tenantId: string,
    query?: { search?: string; isActive?: boolean; parentId?: string | null },
  ): Promise<OrgUnit[]> {
    const filter: FilterQuery<OrgUnitSchemaClass> = { tenantId };

    if (query?.search) {
      const safe = escapeRegex(query.search);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { code: { $regex: safe, $options: 'i' } },
      ];
    }
    if (query?.isActive !== undefined) filter.isActive = query.isActive;
    if (query?.parentId !== undefined) filter.parentId = query.parentId;

    const docs = await this.model.find(filter).sort({ path: 1 }).lean().exec();
    return docs.map(OrgUnitMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<OrgUnit | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).lean().exec();
    return doc ? OrgUnitMapper.toDomain(doc) : null;
  }

  async findByCode(tenantId: string, code: string): Promise<OrgUnit | null> {
    const doc = await this.model.findOne({ tenantId, code }).lean().exec();
    return doc ? OrgUnitMapper.toDomain(doc) : null;
  }

  /**
   * Ids of a unit and every unit beneath it, as one indexed prefix scan.
   *
   * The unit's own `path` already ends in its id and a delimiter, so a prefix
   * match on it returns the unit plus its descendants and nothing else — the
   * trailing `/` is what stops `/a/b/` from also matching a sibling `/a/bc/`.
   * `escapeRegex` is applied even though a stored path only ever contains hex
   * and `/`: it costs nothing and means a corrupted row cannot turn this into
   * an attacker-influenced pattern.
   *
   * Returns [] for an unknown id rather than throwing, and the caller treats []
   * as "no visible units" — an org unit that has been deleted mid-request must
   * narrow the scope, never widen it.
   */
  async findSubtreeIds(tenantId: string, unitId: string): Promise<string[]> {
    const unit = await this.model
      .findOne({ _id: unitId, tenantId }, { path: 1 })
      .lean()
      .exec();
    if (!unit?.path) return [];

    const docs = await this.model
      .find(
        { tenantId, path: { $regex: `^${escapeRegex(unit.path)}` } },
        { _id: 1 },
      )
      .lean()
      .exec();
    return docs.map((d: any) => String(d._id));
  }

  /**
   * Ids of every unit `userId` manages, plus everything beneath each of them.
   *
   * One query for the managed roots and one prefix query for their subtrees,
   * regardless of how many units the principal manages. The alternative —
   * calling findSubtreeIds per root — is two round trips per unit on a path
   * that runs on every request.
   *
   * Both `managerId` (the primary head) and `managerIds` (co-managers) count:
   * the two fields are one manager set, and a tenant that only ever set the
   * legacy single field must keep working unchanged.
   */
  async findManagedSubtreeIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    if (!Types.ObjectId.isValid(userId)) return [];
    const asObjectId = new Types.ObjectId(userId);

    const roots = await this.model
      .find(
        {
          tenantId,
          isActive: true,
          $or: [{ managerId: asObjectId }, { managerIds: asObjectId }],
        },
        { _id: 1, path: 1 },
      )
      .lean()
      .exec();
    if (roots.length === 0) return [];

    const docs = await this.model
      .find(
        {
          tenantId,
          $or: roots.map((r: any) => ({
            path: { $regex: `^${escapeRegex(String(r.path))}` },
          })),
        },
        { _id: 1 },
      )
      .lean()
      .exec();

    return [...new Set(docs.map((d: any) => String(d._id)))];
  }

  /** Ancestor ids of a unit, self excluded, root-first. Read from `path`. */
  async findAncestorIds(tenantId: string, unitId: string): Promise<string[]> {
    const unit = await this.model
      .findOne({ _id: unitId, tenantId }, { path: 1 })
      .lean()
      .exec();
    if (!unit?.path) return [];
    const ids = unit.path.split('/').filter(Boolean);
    return ids.slice(0, -1); // drop self
  }

  /**
   * Insert a unit with its `path` already correct.
   *
   * The `_id` is generated here rather than by Mongo so the path — which must
   * contain the row's own id — is computable before the write. That makes
   * creation a single insert: there is no window in which a unit exists with an
   * unset or wrong path, which would place it outside every subtree prefix and
   * make records it owns briefly invisible to the very people who should see
   * them.
   */
  async create(data: Partial<OrgUnit>, parentPath: string): Promise<OrgUnit> {
    const _id = new Types.ObjectId();
    const path = `${parentPath}${_id.toHexString()}/`;
    const doc = await this.model.create({
      ...OrgUnitMapper.toPersistence(data),
      _id,
      path,
      depth: path.split('/').filter(Boolean).length - 1,
    });
    return OrgUnitMapper.toDomain(doc.toObject());
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<OrgUnit>,
  ): Promise<OrgUnit | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        { $set: OrgUnitMapper.toPersistence(data) },
        { new: true },
      )
      .lean()
      .exec();
    return doc ? OrgUnitMapper.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }

  /** Direct children count — used to refuse deleting a non-leaf unit. */
  async countChildren(tenantId: string, id: string): Promise<number> {
    return this.model.countDocuments({ tenantId, parentId: id }).exec();
  }

  /**
   * Rewrite `path`/`depth` for a moved unit and its whole subtree, in one
   * bulkWrite. Every descendant keeps its position relative to the moved unit:
   * only the shared prefix changes.
   */
  async rewriteSubtreePaths(
    tenantId: string,
    oldPath: string,
    newPath: string,
  ): Promise<number> {
    const docs = await this.model
      .find(
        { tenantId, path: { $regex: `^${escapeRegex(oldPath)}` } },
        { _id: 1, path: 1 },
      )
      .lean()
      .exec();
    if (docs.length === 0) return 0;

    const ops = docs.map((d: any) => {
      const rewritten = newPath + String(d.path).slice(oldPath.length);
      return {
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: {
              path: rewritten,
              depth: rewritten.split('/').filter(Boolean).length - 1,
            },
          },
        },
      };
    });

    const result = await this.model.bulkWrite(ops);
    return result.modifiedCount ?? 0;
  }
}
