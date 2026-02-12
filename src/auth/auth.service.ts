import {
  HttpStatus,
  Injectable,
  Inject,
  forwardRef,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, from } from 'rxjs';
import { AuthUpdateDto } from './dto/auth-update.dto';
import { NullableType } from '../utils/types/nullable.type';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AllConfigType } from '../config/config.type';
import { User } from '../users/domain/user';
import { AuthProvidersEnum } from './auth-providers.enum';
import { RoleEnum } from '../roles/roles.enum';
import { StatusEnum } from '../statuses/statuses.enum';

@Injectable()
export class AuthService {
  constructor(
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    private configService: ConfigService<AllConfigType>,
    private httpService: HttpService,
  ) { }

  getLoginUrl(): string {
    const authServerUrl = this.configService.getOrThrow('keycloak.authServerUrl', { infer: true });
    const realm = this.configService.getOrThrow('keycloak.realm', { infer: true });
    const clientId = this.configService.getOrThrow('keycloak.clientId', { infer: true });
    const callbackUrl = this.configService.getOrThrow('keycloak.callbackUrl', { infer: true });

    console.log(authServerUrl, realm, clientId, callbackUrl);

    return `${authServerUrl}/realms/${realm}/protocol/openid-connect/auth?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=openid%20profile%20email`;
  }

  async getAccessToken(code: string): Promise<any> {
    const authServerUrl = this.configService.getOrThrow('keycloak.authServerUrl', { infer: true });
    const realm = this.configService.getOrThrow('keycloak.realm', { infer: true });
    const clientId = this.configService.getOrThrow('keycloak.clientId', { infer: true });
    const clientSecret = this.configService.getOrThrow('keycloak.clientSecret', { infer: true });
    const callbackUrl = this.configService.getOrThrow('keycloak.callbackUrl', { infer: true });

    const tokenUrl = `${authServerUrl}/realms/${realm}/protocol/openid-connect/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('code', code);
    params.append('redirect_uri', callbackUrl);

    try {
      const response = await firstValueFrom(this.httpService.post(tokenUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }));
      return response.data;
    } catch (error) {
      throw new UnauthorizedException('Failed to exchange code for token');
    }
  }

  async me(keycloakPayload: any): Promise<NullableType<User>> {
    const keycloakId = keycloakPayload.sub;
    const email = keycloakPayload.email;

    let user = await this.usersService.findByKeycloakIdAndProvider({
      keycloakId,
      provider: AuthProvidersEnum.email, // Or logic to determine provider based on token
    });

    if (!user && email) {
      // Try to find by email if not found by keycloakId (migration scenario)
      user = await this.usersService.findByEmail(email);
      if (user) {
        // Link existing user
        user.keycloakId = keycloakId;
        await this.usersService.update(user.id, user);
      }
    }

    if (!user) {
      // JIT Provisioning
      const role = { id: RoleEnum.user };
      const status = { id: StatusEnum.active };

      user = await this.usersService.create({
        email: email,
        firstName: keycloakPayload.given_name,
        lastName: keycloakPayload.family_name,
        keycloakId: keycloakId,
        provider: AuthProvidersEnum.email,
        role,
        status,
      });
    }

    return user;
  }

  async update(
    keycloakPayload: any,
    userDto: AuthUpdateDto,
  ): Promise<NullableType<User>> {
    const user = await this.me(keycloakPayload);
    if (!user) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          user: 'userNotFound',
        },
      });
    }

    if (userDto.oldPassword || userDto.password) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          password: 'cannotChangePasswordHere',
        },
      });
    }

    // Email update logic removed as it should be handled in Keycloak
    if (userDto.email) {
      // Optionally block or allow. For now, allow local update but log warning ideally.
    }

    await this.usersService.update(user.id, userDto);
    return this.usersService.findById(user.id);
  }

  async softDelete(keycloakPayload: any): Promise<void> {
    const user = await this.me(keycloakPayload);
    if (user) {
      await this.usersService.remove(user.id);
    }
  }
}
