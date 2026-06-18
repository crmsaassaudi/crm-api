import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ObjectAclService, type AclEntry } from './object-acl.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

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
  constructor(private readonly aclService: ObjectAclService) {}

  @Get()
  @ApiOperation({ summary: 'List all ACL entries for a resource record' })
  async list(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
    @Req() req: any,
  ) {
    const tenantId = req.user?.tenantId ?? req.headers['x-tenant-id'];
    return this.aclService.getForResource(tenantId, resourceType, resourceId);
  }

  @Put()
  @ApiOperation({ summary: 'Upsert an ACL entry (grant or deny access)' })
  async upsert(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: UpsertAclDto,
    @Req() req: any,
  ) {
    const tenantId = req.user?.tenantId ?? req.headers['x-tenant-id'];
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
  async remove(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
    @Param('principalId') principalId: string,
    @Req() req: any,
  ) {
    const tenantId = req.user?.tenantId ?? req.headers['x-tenant-id'];
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
  async removeAll(
    @Param('resourceType') resourceType: string,
    @Param('resourceId') resourceId: string,
    @Req() req: any,
  ) {
    const tenantId = req.user?.tenantId ?? req.headers['x-tenant-id'];
    await this.aclService.removeAllForResource(
      tenantId,
      resourceType,
      resourceId,
    );
  }
}
