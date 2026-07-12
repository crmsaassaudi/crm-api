import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';

import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';
import { AuthProvidersEnum } from '../../auth/auth-providers.enum';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { TenantRoleEnum } from '../../roles/tenant-role.enum';
import { StatusEnum } from '../../statuses/statuses.enum';
import { UserSchemaClass } from '../../users/infrastructure/persistence/document/entities/user.schema';
import { TenantSchemaClass } from '../../tenants/infrastructure/persistence/document/entities/tenant.schema';
import { SubscriptionPlan, TenantStatus } from '../../tenants/domain/tenant';
import {
  TenantAliasReservationSchemaClass,
  AliasReservationStatus,
} from '../../tenants/infrastructure/persistence/document/entities/tenant-alias-reservation.schema';

/**
 * Resolved configuration for the master organization, read from env with
 * sensible defaults. See the class-level docs on {@link MasterOrgInitService}.
 */
export interface MasterOrgConfig {
  name: string;
  alias: string;
  adminEmail: string;
  adminFullName: string;
  /** Empty => a strong password is generated and printed once. */
  adminPassword: string;
  plan: SubscriptionPlan;
}

export interface MasterOrgInitResult {
  tenantId: string;
  keycloakOrgId: string;
  alias: string;
  userId: string;
  keycloakUserId: string;
  adminEmail: string;
  /** Only set when this run created the Keycloak user with a fresh password. */
  generatedPassword?: string;
  loginUrls: { crm: string; manager: string };
}

/**
 * Idempotently provisions the internal "master" organization and its owner —
 * the one tenant whose owner also gets `platformRole = SUPER_ADMIN`, granting
 * access to manager-api / manager-web ON TOP of normal (multi-tenant) CRM use.
 *
 * Design mirrors the production tenant-provisioning saga
 * (crm-api/src/tenants/workers/tenant-provisioning.worker.ts) so it never
 * drifts from how real tenants are created — the ONLY extra, privileged step
 * is promoting the owner's platformRole to SUPER_ADMIN.
 *
 * Every step is find-or-create: re-running on the same (or a partially
 * initialised) environment fills gaps and never duplicates or crashes.
 */
@Injectable()
export class MasterOrgInitService {
  private readonly logger = new Logger(MasterOrgInitService.name);

  constructor(
    private readonly keycloak: KeycloakAdminService,
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<UserSchemaClass>,
    @InjectModel(TenantSchemaClass.name)
    private readonly tenantModel: Model<TenantSchemaClass>,
    @InjectModel(TenantAliasReservationSchemaClass.name)
    private readonly aliasModel: Model<TenantAliasReservationSchemaClass>,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────────────

  static readConfig(): MasterOrgConfig {
    const name = process.env.MASTER_ORG_NAME?.trim() || 'CRM Saudi';
    const alias = (process.env.MASTER_ORG_ALIAS?.trim() || 'master')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    const adminEmail = (
      process.env.MASTER_ADMIN_EMAIL?.trim() || 'nguyentoan102002@gmail.com'
    ).toLowerCase();
    const adminFullName =
      process.env.MASTER_ADMIN_FULLNAME?.trim() || 'CRM Saudi Admin';
    const adminPassword = process.env.MASTER_ADMIN_PASSWORD ?? '';
    const planRaw = (
      process.env.MASTER_ORG_PLAN?.trim() || 'ENTERPRISE'
    ).toUpperCase();
    const plan = (Object.values(SubscriptionPlan) as string[]).includes(planRaw)
      ? (planRaw as SubscriptionPlan)
      : SubscriptionPlan.ENTERPRISE;

    return { name, alias, adminEmail, adminFullName, adminPassword, plan };
  }

  /**
   * Generates a strong password that satisfies typical Keycloak policies:
   * >= 20 chars with at least one lower, upper, digit and symbol.
   */
  private static generatePassword(): string {
    const pick = (set: string, n: number) =>
      Array.from(
        { length: n },
        (_, i) => set[randomBytes(1)[0] % set.length],
      ).join('');
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digit = '23456789';
    const symbol = '!@#$%^&*-_=+';
    const all = lower + upper + digit + symbol;
    // Guarantee one of each class, then fill to 24 chars, then shuffle.
    const base =
      pick(lower, 1) + pick(upper, 1) + pick(digit, 1) + pick(symbol, 1);
    const chars = (base + pick(all, 20)).split('');
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomBytes(1)[0] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  // ── Main ────────────────────────────────────────────────────────────────────

  async run(cfg: MasterOrgConfig): Promise<MasterOrgInitResult> {
    this.logger.log(
      `Initialising master org "${cfg.name}" (alias="${cfg.alias}", admin=${cfg.adminEmail})`,
    );

    // ── Step 1: Keycloak organization (find-or-create) ──────────────────────────
    let kcOrg = await this.keycloak.findOrganizationByAlias(cfg.alias);
    if (kcOrg) {
      this.logger.log(`KC org exists: ${kcOrg.id}`);
    } else {
      kcOrg = await this.keycloak.createOrganization(cfg.name, cfg.alias);
      this.logger.log(`KC org created: ${kcOrg.id}`);
    }

    // ── Step 2: Keycloak user (find-or-create) ──────────────────────────────────
    let generatedPassword: string | undefined;
    let kcUser = await this.keycloak.findUserByEmail(cfg.adminEmail);
    if (kcUser) {
      this.logger.log(`KC user exists: ${kcUser.id} — password left unchanged`);
    } else {
      generatedPassword =
        cfg.adminPassword || MasterOrgInitService.generatePassword();
      kcUser = await this.keycloak.createUser(
        cfg.adminEmail,
        generatedPassword,
        cfg.adminFullName,
      );
      this.logger.log(`KC user created: ${kcUser.id}`);
    }
    const keycloakUserId = kcUser.id;

    // ── Step 3: Add user to org (idempotent) ────────────────────────────────────
    try {
      await this.keycloak.addUserToOrganization(kcOrg.id, keycloakUserId);
    } catch (e: any) {
      // Already a member → Keycloak returns 409; treat as success.
      if (e?.response?.status === 409) {
        this.logger.log('KC user already a member of the org');
      } else {
        throw e;
      }
    }

    // ── Step 4: Mongo tenant (find-or-create) ───────────────────────────────────
    let tenant = await this.tenantModel.findOne({ alias: cfg.alias }).exec();
    if (tenant) {
      this.logger.log(`Tenant exists: ${tenant._id.toString()}`);
      // Keep the KC linkage authoritative in case the org was recreated.
      if (tenant.keycloakOrgId !== kcOrg.id) {
        tenant.keycloakOrgId = kcOrg.id;
        await tenant.save();
      }
    } else {
      tenant = await new this.tenantModel({
        keycloakOrgId: kcOrg.id,
        alias: cfg.alias,
        name: cfg.name,
        subscriptionPlan: cfg.plan,
        status: TenantStatus.ACTIVE,
        // ENTERPRISE master org: unlimited storage. Other sub-docs use schema defaults.
        storageQuota: {
          limitBytes: -1,
          usedBytes: 0,
          warnThresholdPercent: 80,
        },
      }).save();
      this.logger.log(`Tenant created: ${tenant._id.toString()}`);
    }
    const tenantId = tenant._id.toString();

    // ── Step 5: Mongo user (upsert as SUPER_ADMIN + OWNER of master tenant) ──────
    let user = await this.userModel
      .findOne({ keycloakId: keycloakUserId })
      .exec();
    if (!user) {
      // Fall back to email in case a doc exists without keycloakId linked yet.
      user = await this.userModel.findOne({ email: cfg.adminEmail }).exec();
    }

    const spaceIdx = cfg.adminFullName.indexOf(' ');
    const firstName =
      spaceIdx > -1 ? cfg.adminFullName.slice(0, spaceIdx) : cfg.adminFullName;
    const lastName = spaceIdx > -1 ? cfg.adminFullName.slice(spaceIdx + 1) : '';

    if (!user) {
      user = await new this.userModel({
        email: cfg.adminEmail,
        firstName,
        lastName,
        provider: AuthProvidersEnum.email,
        keycloakId: keycloakUserId,
        platformRole: PlatformRoleEnum.SUPER_ADMIN, // <-- the privileged step
        status: StatusEnum.active,
        onboardingStatus: 'COMPLETED',
        tenants: [
          {
            tenantId: new Types.ObjectId(tenantId),
            roles: [TenantRoleEnum.OWNER],
            permissions: [],
            joinedAt: new Date(),
          },
        ],
      }).save();
      this.logger.log(`User created: ${user._id.toString()}`);
    } else {
      // Promote + ensure OWNER membership without duplicating it.
      user.keycloakId = keycloakUserId;
      user.platformRole = PlatformRoleEnum.SUPER_ADMIN;
      user.status = StatusEnum.active;
      user.onboardingStatus = 'COMPLETED';
      const membership = user.tenants.find(
        (t) => t.tenantId?.toString() === tenantId,
      );
      if (!membership) {
        user.tenants.push({
          tenantId: new Types.ObjectId(tenantId) as any,
          roles: [TenantRoleEnum.OWNER],
          permissions: [],
          joinedAt: new Date(),
        });
      } else if (!membership.roles.includes(TenantRoleEnum.OWNER)) {
        membership.roles.push(TenantRoleEnum.OWNER);
      }
      await user.save();
      this.logger.log(
        `User promoted to SUPER_ADMIN + OWNER: ${user._id.toString()}`,
      );
    }
    const userId = user._id.toString();

    // ── Step 6: Set tenant owner ────────────────────────────────────────────────
    if (tenant.ownerId?.toString() !== userId) {
      tenant.ownerId = new Types.ObjectId(userId);
      await tenant.save();
      this.logger.log(`Tenant owner set to ${userId}`);
    }

    // ── Step 7: Confirm + pin the alias reservation (never TTL-expires) ─────────
    const farFuture = new Date('2999-12-31T00:00:00Z');
    await this.aliasModel.updateOne(
      { alias: cfg.alias },
      {
        $set: {
          status: AliasReservationStatus.CONFIRMED,
          expiresAt: farFuture,
        },
        $setOnInsert: { alias: cfg.alias, createdAt: new Date() },
      },
      { upsert: true },
    );

    const rootDomain = process.env.APP_ROOT_DOMAIN || 'crmsaudi.dev';
    const managerUrl =
      process.env.MANAGER_FRONTEND_URL || `https://manager.${rootDomain}`;

    return {
      tenantId,
      keycloakOrgId: kcOrg.id,
      alias: cfg.alias,
      userId,
      keycloakUserId,
      adminEmail: cfg.adminEmail,
      generatedPassword,
      loginUrls: {
        crm: `https://${cfg.alias}.${rootDomain}/login`,
        manager: managerUrl,
      },
    };
  }
}
