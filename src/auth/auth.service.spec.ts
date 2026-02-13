import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { AuthProvidersEnum } from './auth-providers.enum';

describe('AuthService', () => {
    let service: AuthService;
    let usersService: Partial<UsersService>;
    let redisService: Partial<RedisService>;
    let redisClient: any;

    beforeEach(async () => {
        redisClient = {
            set: jest.fn().mockResolvedValue('OK'),
            del: jest.fn().mockResolvedValue(1),
        };

        redisService = {
            getClient: jest.fn().mockReturnValue(redisClient),
        };

        usersService = {
            findByKeycloakIdAndProvider: jest.fn(),
            findByEmail: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthService,
                { provide: UsersService, useValue: usersService },
                { provide: HttpService, useValue: {} },
                { provide: ConfigService, useValue: { getOrThrow: jest.fn() } },
                { provide: RedisService, useValue: redisService },
            ],
        }).compile();

        service = module.get<AuthService>(AuthService);
    });

    it('should sync tenants correctly (Add New, Remove Old)', async () => {
        const keycloakPayload = {
            sub: 'keycloak-123',
            email: 'test@example.com',
            tenants: ['tenant-1', 'tenant-3'], // Tenant 2 removed, Tenant 3 added
        };

        const existingUser = {
            id: 'user-1',
            keycloakId: 'keycloak-123',
            email: 'test@example.com',
            tenants: [
                { tenant: 'tenant-1', roles: [], joinedAt: new Date() },
                { tenant: 'tenant-2', roles: [], joinedAt: new Date() },
            ],
            provider: AuthProvidersEnum.email,
        };

        (usersService.findByKeycloakIdAndProvider as jest.Mock).mockResolvedValue(existingUser);

        await service.me(keycloakPayload);

        expect(usersService.update).toHaveBeenCalledWith('user-1', expect.objectContaining({
            tenants: expect.arrayContaining([
                expect.objectContaining({ tenant: 'tenant-1' }),
                expect.objectContaining({ tenant: 'tenant-3' }),
            ]),
        }));

        // Verify tenant-2 is gone
        const updateCall = (usersService.update as jest.Mock).mock.calls[0][1];
        const tenants = updateCall.tenants.map((t: any) => t.tenant);
        expect(tenants).toContain('tenant-1');
        expect(tenants).toContain('tenant-3');
        expect(tenants).not.toContain('tenant-2');
    });

    it('should handle JIT provisioning', async () => {
        const keycloakPayload = {
            sub: 'new-keycloak-id',
            email: 'new@example.com',
            given_name: 'New',
            family_name: 'User',
            tenants: ['tenant-A'],
        };

        (usersService.findByKeycloakIdAndProvider as jest.Mock).mockResolvedValue(null);
        (usersService.findByEmail as jest.Mock).mockResolvedValue(null);

        await service.me(keycloakPayload);

        expect(usersService.create).toHaveBeenCalledWith(expect.objectContaining({
            email: 'new@example.com',
            keycloakId: 'new-keycloak-id',
            tenants: expect.arrayContaining([
                expect.objectContaining({ tenant: 'tenant-A' }),
            ]),
        }));
    });

    it('should skip sync if locked', async () => {
        // Simulate Lock Acquisition Failure (null means valid key not set because it exists? No, NX returns null if exists)
        // Actually ioredis set with NX returns 'OK' if set, null if not set.
        redisClient.set.mockResolvedValue(null);

        const keycloakPayload = { sub: 'locked-user', email: 'locked@test.com' };

        // It should try to find existing user and return it
        (usersService.findByKeycloakIdAndProvider as jest.Mock).mockResolvedValue({ id: 'existing' });

        const result = await service.me(keycloakPayload);

        expect(result).toEqual({ id: 'existing' });
        // Should NOT call update or create
        expect(usersService.update).not.toHaveBeenCalled();
        expect(usersService.create).not.toHaveBeenCalled();
    });
});
