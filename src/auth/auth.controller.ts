import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Request,
  Patch,
  Delete,
  SerializeOptions,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { jwtDecode } from 'jwt-decode';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';
import { AuthService } from './auth.service';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { AuthUpdateDto } from './dto/auth-update.dto';
import { NullableType } from '../utils/types/nullable.type';
import { User } from '../users/domain/user';

@ApiTags('Auth')
@Controller({
  path: 'auth',
  version: '1',
})
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly configService: ConfigService<AllConfigType>,
  ) { }

  @Get('login')
  @Unprotected()
  @HttpCode(HttpStatus.FOUND)
  login(@Res() res: Response) {
    const loginUrl = this.service.getLoginUrl();
    return res.redirect(loginUrl);
  }

  @Get('callback')
  @Unprotected()
  @HttpCode(HttpStatus.FOUND)
  async callback(@Query('code') code: string, @Res() res: Response) {
    console.log('--------------------------------------------------');
    console.log('Callback code:', code);
    console.log('--------------------------------------------------');

    if (!code) {
      const frontendDomain = this.configService.getOrThrow('app.frontendDomain', { infer: true }) || 'http://localhost:3000';
      return res.redirect(`${frontendDomain}/login?error=no_code`);
    }
    try {
      const tokens = await this.service.getAccessToken(code);
      console.log('--------------------------------------------------');
      console.log('Tokens received:', JSON.stringify(tokens, null, 2));
      console.log('--------------------------------------------------');

      const accessToken = tokens.access_token;
      const decoded: any = jwtDecode(accessToken);
      console.log('Decoded token payload:', JSON.stringify(decoded, null, 2));
      console.log('--------------------------------------------------');

      // Sync user (JIT)
      await this.service.me(decoded);

      const frontendDomain = this.configService.getOrThrow('app.frontendDomain', { infer: true }) || 'http://localhost:3000';
      return res.redirect(`${frontendDomain}/auth-redirect?token=${accessToken}`);
    } catch (e) {
      console.error('Callback error', e);
      const frontendDomain = this.configService.getOrThrow('app.frontendDomain', { infer: true }) || 'http://localhost:3000';
      return res.redirect(`${frontendDomain}/login?error=callback_failed`);
    }
  }

  @ApiBearerAuth()
  @SerializeOptions({
    groups: ['me'],
  })
  @Get('me')
  @ApiOkResponse({
    type: User,
  })
  @HttpCode(HttpStatus.OK)
  public me(@Request() request): Promise<NullableType<User>> {
    return this.service.me(request.user);
  }

  @ApiBearerAuth()
  @SerializeOptions({
    groups: ['me'],
  })
  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: User,
  })
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
}
