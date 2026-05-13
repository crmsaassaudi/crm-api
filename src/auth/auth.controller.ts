import {
  Body,
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Request,
  Patch,
  Delete,
  SerializeOptions,
  Query,
  Res,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';
import { AuthService } from './auth.service';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { AuthUpdateDto } from './dto/auth-update.dto';
import { NullableType } from '../utils/types/nullable.type';
import { User } from '../users/domain/user';
import { Tenant } from '../tenants/domain/tenant';
import {
  SID_COOKIE,
  clearSessionCookieVariants,
  getSessionCookieOptions,
} from './session-cookie.util';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly service: AuthService,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  @Get('login')
  @Unprotected()
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({ summary: 'Initiate OAuth 2.0 Authorization Code Flow' })
  async login(
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ) {
    const { url } = await this.service.buildLoginUrl(returnTo);
    return res.redirect(url);
  }

  @Get('callback')
  @Unprotected()
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({ summary: 'Handle Keycloak OAuth callback' })
  async callback(
    @Request() req,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.getOrThrow('keycloak.frontendUrl', {
      infer: true,
    });

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/login?error=missing_params`);
    }

    try {
      const { sid, redirectUrl } = await this.service.handleCallback(
        code,
        state,
      );

      // Tokens stay server-side; the browser receives only an HttpOnly sid.
      clearSessionCookieVariants(res, this.configService, req.hostname);
      res.cookie(
        SID_COOKIE,
        sid,
        getSessionCookieOptions(this.configService, req.hostname),
      );

      return res.redirect(redirectUrl);
    } catch (e: any) {
      this.logger.error('Callback error', e?.message);
      return res.redirect(`${frontendUrl}/login?error=callback_failed`);
    }
  }

  @Post('refresh')
  @Unprotected()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Silent token refresh using session cookie' })
  async refresh(@Request() req, @Res({ passthrough: true }) res: Response) {
    const sidCandidates = this.getSidCandidates(req);
    if (sidCandidates.length === 0) {
      throw new UnauthorizedException('No session cookie');
    }

    for (const sid of sidCandidates) {
      try {
        await this.service.refreshTokens(sid);
        return { message: 'Token refreshed successfully' };
      } catch {
        // Try the next sid candidate.
      }
    }

    clearSessionCookieVariants(res, this.configService, req.hostname);
    throw new UnauthorizedException('Session expired - please log in again');
  }

  @Post('logout')
  @Unprotected()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Logout: clear session, cookie, and Keycloak IdP session',
  })
  async logout(@Request() req, @Res({ passthrough: true }) res: Response) {
    for (const sid of this.getSidCandidates(req)) {
      await this.service.logout(sid).catch(() => undefined);
    }

    clearSessionCookieVariants(res, this.configService, req.hostname);
  }

  @ApiBearerAuth()
  @SerializeOptions({ groups: ['me'] })
  @Get('me')
  @ApiOkResponse({ type: User })
  @HttpCode(HttpStatus.OK)
  public async me(@Request() req): Promise<NullableType<User>> {
    return this.service.me(req.user);
  }

  @ApiBearerAuth()
  @Get('tenants')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: Tenant, isArray: true })
  public async myTenants(@Request() req): Promise<Tenant[]> {
    return this.service.myTenants(req.user);
  }

  @ApiBearerAuth()
  @SerializeOptions({ groups: ['me'] })
  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: User })
  public update(
    @Request() request,
    @Body() userDto: AuthUpdateDto,
  ): Promise<NullableType<User>> {
    return this.service.update(request.user, userDto);
  }

  @ApiBearerAuth()
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async delete(@Request() request): Promise<void> {
    return this.service.softDelete(request.user);
  }

  private getSidCandidates(req: any): string[] {
    const candidates: string[] = [];
    const parsedSid = req.cookies?.[SID_COOKIE];
    if (typeof parsedSid === 'string' && parsedSid) {
      candidates.push(parsedSid);
    }

    const rawCookieHeader = req.headers?.cookie;
    const rawCookie = Array.isArray(rawCookieHeader)
      ? rawCookieHeader.join(';')
      : rawCookieHeader;

    if (rawCookie) {
      for (const part of rawCookie.split(';')) {
        const [rawName, ...rawValueParts] = part.trim().split('=');
        if (rawName !== SID_COOKIE) continue;

        const rawValue = rawValueParts.join('=');
        if (!rawValue) continue;

        try {
          candidates.push(decodeURIComponent(rawValue));
        } catch {
          candidates.push(rawValue);
        }
      }
    }

    return Array.from(new Set(candidates));
  }
}
