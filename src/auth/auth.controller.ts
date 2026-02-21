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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { AuthUpdateDto } from './dto/auth-update.dto';
import { NullableType } from '../utils/types/nullable.type';
import { User } from '../users/domain/user';
import { SessionService } from './services/session.service';

const SID_COOKIE = 'sid';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  // Domain should be set to .yourcrm.com in production via env
  // domain: process.env.COOKIE_DOMAIN,
};

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly service: AuthService,
    private readonly sessionService: SessionService,
    private readonly configService: ConfigService<AllConfigType>,
  ) { }

  // ─── GET /auth/login ──────────────────────────────────────────────────────

  @Get('login')
  @Unprotected()
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({ summary: 'Initiate OAuth 2.0 Authorization Code Flow' })
  async login(@Res() res: Response) {
    const { url } = await this.service.buildLoginUrl();
    return res.redirect(url);
  }

  // ─── GET /auth/callback ───────────────────────────────────────────────────

  @Get('callback')
  @Unprotected()
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({ summary: 'Handle Keycloak OAuth callback' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.getOrThrow('keycloak.frontendUrl', { infer: true });

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/login?error=missing_params`);
    }

    try {
      const { sid, redirectUrl } = await this.service.handleCallback(code, state);

      // Set HttpOnly session cookie — token NEVER reaches the browser
      res.cookie(SID_COOKIE, sid, COOKIE_OPTIONS);

      return res.redirect(redirectUrl);
    } catch (e: any) {
      this.logger.error('Callback error', e?.message);
      return res.redirect(`${frontendUrl}/login?error=callback_failed`);
    }
  }

  // ─── POST /auth/refresh ───────────────────────────────────────────────────

  @Post('refresh')
  @Unprotected()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Silent token refresh using session cookie' })
  async refresh(@Request() req, @Res({ passthrough: true }) res: Response) {
    const sid = req.cookies?.[SID_COOKIE];
    if (!sid) {
      throw new UnauthorizedException('No session cookie');
    }

    try {
      await this.service.refreshTokens(sid);
      return { message: 'Token refreshed successfully' };
    } catch (e) {
      // Refresh token expired → clear cookie and force re-login
      res.clearCookie(SID_COOKIE, COOKIE_OPTIONS);
      throw new UnauthorizedException('Session expired — please log in again');
    }
  }

  // ─── POST /auth/logout ────────────────────────────────────────────────────

  @Post('logout')
  @Unprotected()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout: clear session, cookie, and Keycloak IdP session' })
  async logout(@Request() req, @Res({ passthrough: true }) res: Response) {
    const sid = req.cookies?.[SID_COOKIE];
    if (sid) {
      await this.service.logout(sid);
    }
    // Clear cookie regardless (Max-Age=0 equivalent)
    res.clearCookie(SID_COOKIE, COOKIE_OPTIONS);
  }

  // ─── GET /auth/me ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @SerializeOptions({ groups: ['me'] })
  @Get('me')
  @ApiOkResponse({ type: User })
  @HttpCode(HttpStatus.OK)
  public async me(@Request() req): Promise<NullableType<User>> {
    // Support both: session cookie (BFF) and Bearer JWT (API clients)
    const sid = req.cookies?.[SID_COOKIE];
    if (sid) {
      const session = await this.sessionService.getSession(sid);
      if (!session) throw new UnauthorizedException('Session invalid or expired');
      return this.service.me(this.decodeJwt(session.idToken));
    }
    // Fallback: Keycloak JWT bearer token (set by nest-keycloak-connect)
    return this.service.me(req.user);
  }

  // ─── PATCH /auth/me ───────────────────────────────────────────────────────

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

  // ─── DELETE /auth/me ─────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async delete(@Request() request): Promise<void> {
    return this.service.softDelete(request.user);
  }

  // ─── Helper ──────────────────────────────────────────────────────────────

  private decodeJwt(token: string): any {
    const base64 = token.split('.')[1];
    return JSON.parse(Buffer.from(base64, 'base64url').toString('utf-8'));
  }
}
