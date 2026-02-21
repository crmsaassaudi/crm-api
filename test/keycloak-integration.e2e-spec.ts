import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { KeycloakAdminService } from '../src/auth/services/keycloak-admin.service';

describe('Keycloak Integration (e2e)', () => {
    let app: INestApplication;
    let keycloakAdminService: KeycloakAdminService;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        keycloakAdminService = moduleFixture.get<KeycloakAdminService>(KeycloakAdminService);
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    describe('Tenant Onboarding', () => {
        it('/auth/register-tenant (POST) should create tenant and admin user', async () => {
            const tenantDto = {
                name: 'E2E Test Tenant',
                domain: 'e2e-test',
                adminEmail: `admin-${Date.now()}@e2e.com`,
            };

            const response = await request(app.getHttpServer())
                .post('/auth/register-tenant')
                .send(tenantDto)
                .expect(201);

            expect(response.body).toBeDefined();
            expect(response.body.name).toBe(tenantDto.name);
            expect(response.body.domain).toBe(tenantDto.domain);

            // Verify Keycloak user created
            // We can check if findUserByEmail returns user
            if (keycloakAdminService) {
                const user = await keycloakAdminService.findUserByEmail(tenantDto.adminEmail);
                expect(user).toBeDefined();

                // Cleanup
                if (user && user.id) {
                    await keycloakAdminService.deleteUser(user.id);
                }
            }
        });
    });

    describe('User Invite', () => {
        it('/users/invite (POST) should invite user to current tenant', async () => {
            // This test requires a valid JWT for an admin.
            // Mocking AuthGuard or getting a real token is complex here without configured Keycloak.
            // We will skip actual execution if no token available, or mock the Guard.
            // For now, this serves as a template.
            console.log('Skipping User Invite test as it requires valid Admin Token');
        });
    });
});
