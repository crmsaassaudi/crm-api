import {
  Controller,
  ForbiddenException,
  Get,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ObjectAclService, type AclEntry } from './object-acl.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RequirePermission } from './index';

class UpsertAclDto {
  principalType: 'user' | 'group';
  principalId: string;
  permissions: string[];
  isDeny?: boolean;
}

/**
 * ObjectAclController — REST API for managing per-record ACL.
 *
 * Mount point: /acl/:resourceType/:resourceId
 *
 * Typical flows:
 *   GET  /acl/deals/664abc…         → list entries for this deal
 *   PUT  /acl/deals/664abc…         → upsert entry (grant/deny user/group access)
 *   DELETE /acl/deals/664abc…/:pid  → remove entry for a specific principal
 */
@ApiTags('Object ACL')
@ApiBearerAuth()
@Controller('acl/:resourceType/:resourceId')
export class ObjectAclController {
  constructor(
    private readonly aclService: ObjectAclService,
    private readonly cls: ClsService,
  ) {}

  /**
   * The tenant comes from CLS only (C-02).
   *
   * These endpoints WRITE access-control entries, so a header-derived tenant
   * would let an admin of one workspace plant ACL rows — including `isDeny` —
   * into another. CLS is populated by TenantInterceptor from the subdomain /
   * session / JWT and is membership-verified.
   */
  private requireTenantId(): string {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    return tenantId;
  }

  @Get()
  @ApiOperation({ summary: 'List all ACL entries for a resource record' })
  @RequirePermission('view', 'settings')
  async list(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
  ) {
    const tenantId = this.requireTenantId();
    return this.aclService.getForResource(tenantId, resourceType, resourceId);
  }

  @Put()
  @ApiOperation({ summary: 'Upsert an ACL entry (grant or deny access)' })
  @RequirePermission('manage_system', 'settings')
  async upsert(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: UpsertAclDto,
  ) {
    const tenantId = this.requireTenantId();
    const entry: AclEntry = {
      tenantId,
      resourceType,
      resourceId,
      principalType: dto.principalType,
      principalId: dto.principalId,
      permissions: dto.permissions,
      isDeny: dto.isDeny ?? false,
    };
    return this.aclService.upsert(entry);
  }

  @Delete(':principalId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove ACL entry for a principal' })
  @RequirePermission('manage_system', 'settings')
  async remove(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
    @Param('principalId') principalId: string,
  ) {
    const tenantId = this.requireTenantId();
    await this.aclService.remove(
      tenantId,
      resourceType,
      resourceId,
      principalId,
    );
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove ALL ACL entries for a resource record (on delete)',
  })
  @RequirePermission('manage_system', 'settings')
  async removeAll(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
  ) {
    const tenantId = this.requireTenantId();
    await this.aclService.removeAllForResource(
      tenantId,
      resourceType,
      resourceId,
    );
  }
}
