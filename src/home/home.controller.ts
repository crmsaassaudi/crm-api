import { Controller, Get, Version } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';

import { HomeService } from './home.service';

@ApiTags('Home')
@Controller()
export class HomeController {
  constructor(private service: HomeService) {}

  // Returns only the configured app name (no tenant/user data) — safe
  // regardless of auth state; left on the default global guard rather than
  // @Unprotected() since there's no requirement for it to work pre-login.
  @Get()
  appInfo() {
    return this.service.appInfo();
  }

  @Get('health')
  @Version('1')
  @Unprotected()
  health() {
    return { status: 'ok' };
  }
}
