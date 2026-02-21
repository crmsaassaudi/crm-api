import { HttpModule } from '@nestjs/axios';
import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '../users/users.module';
import { KeycloakAdminService } from './services/keycloak-admin.service';
import { SessionService } from './services/session.service';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    HttpModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, KeycloakAdminService, SessionService],
  exports: [AuthService, KeycloakAdminService, SessionService],
})
export class AuthModule { }
