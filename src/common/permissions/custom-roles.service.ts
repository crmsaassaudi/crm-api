import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CustomRoleSchemaClass,
  CustomRoleDocument,
} from './custom-role.schema';
import { CreateCustomRoleDto, UpdateCustomRoleDto } from './custom-roles.dto';
import { PERMISSION_REGISTRY, ALL_PERMISSIONS } from './permission.constants';

@Injectable()
export class CustomRolesService {
  constructor(
    @InjectModel(CustomRoleSchemaClass.name)
    private readonly model: Model<CustomRoleDocument>,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    dto: CreateCustomRoleDto,
  ): Promise<CustomRoleDocument> {
    this.validatePermissions(dto.permissions);
    const role = new this.model({
      tenantId,
      name: dto.name,
      description: dto.description ?? '',
      permissions: dto.permissions ?? [],
      color: dto.color ?? '#6366f1',
    });
    return role.save();
  }

  findAll(tenantId: string): Promise<CustomRoleDocument[]> {
    return this.model
      .find({ tenantId })
      .sort({ isSystem: -1, name: 1 })
      .lean()
      .exec() as any;
  }

  async findById(id: string, tenantId: string): Promise<CustomRoleDocument> {
    const role = (await this.model
      .findOne({ _id: id, tenantId })
      .lean()
      .exec()) as any;
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);
    return role;
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateCustomRoleDto,
  ): Promise<CustomRoleDocument> {
    const role = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);

    if (dto.permissions) this.validatePermissions(dto.permissions);

    Object.assign(role, dto);
    return role.save();
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const role = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted');
    }
    await role.deleteOne();
  }

  // ── Permission matrix ──────────────────────────────────────────────────────

  /**
   * Returns the permission registry grouped by resource,
   * enriched with labels for frontend display.
   */
  getPermissionMatrix() {
    const matrix: Record<string, Array<{ action: string; key: string }>> = {};

    for (const [resource, actions] of Object.entries(PERMISSION_REGISTRY)) {
      matrix[resource] = Object.entries(actions)
        .filter(([, key]) => Boolean(key))
        .map(([action, key]) => ({ action, key: key as string }));
    }

    return {
      matrix,
      allKeys: ALL_PERMISSIONS,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private validatePermissions(permissions?: string[]) {
    if (!permissions?.length) return;
    const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalid.length) {
      throw new BadRequestException(
        `Unknown permission keys: ${invalid.join(', ')}`,
      );
    }
  }
}
