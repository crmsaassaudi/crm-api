import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ObjectConfigService } from './object-config.service';
import { ObjectConfigDto } from './dto/object-config.dto';

/**
 * The object configuration the authenticated caller renders from.
 *
 * Self-scoped by construction: the subject comes from CLS, there is no id to
 * tamper with, and the payload is the caller's own effective policy plus the
 * tenant's own field catalog. So the only authorization question is "is this
 * request authenticated", which is why it carries no `@RequirePermission`.
 *
 * That absence is deliberate and is the fix for a specific failure. The three
 * endpoints this replaces required `settings:view`, a permission no built-in role
 * other than Administrator grants. For a Manager, Sales Rep or Support Agent they
 * returned 403, and the browser read the failure as "no policy configured" — so
 * field-level security silently switched itself off for every non-administrator,
 * which is the inverse of what an admin configuring it intends. Gating a caller's
 * own configuration behind an administration permission is what forced that.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class ObjectConfigController {
  constructor(
    private readonly objectConfig: ObjectConfigService,
    private readonly cls: ClsService,
  ) {}

  @ApiOperation({
    summary:
      'Field catalog and effective field-level policy for every configurable object.',
    description:
      'One request replaces per-module standard-field, custom-field and layout reads. `key` is the payload property; `column` is the rendered-column identity. Clients must not derive either.',
  })
  @ApiOkResponse({ type: ObjectConfigDto })
  @Get('object-config')
  @HttpCode(HttpStatus.OK)
  async myObjectConfig(@Req() request: Request): Promise<ObjectConfigDto> {
    if (!this.cls.get<string>('userId')) {
      // The auth guard should already have rejected this. If it did not, an empty
      // 200 would be read as "no fields configured" and render blank forms rather
      // than sending the user back to sign in.
      throw new UnauthorizedException('Not authenticated');
    }

    return this.objectConfig.forCaller(request);
  }
}
