import { NestFactory } from '@nestjs/core';

import { MasterOrgInitModule } from './master-org-init.module';
import { MasterOrgInitService } from './master-org-init.service';

/**
 * One-shot, idempotent bootstrap of the internal "master" organization.
 *
 * Run once per fresh infrastructure:
 *   npm run init:master-org            (uses env / defaults)
 *
 * Override via env (all optional):
 *   MASTER_ORG_NAME, MASTER_ORG_ALIAS, MASTER_ORG_PLAN,
 *   MASTER_ADMIN_EMAIL, MASTER_ADMIN_FULLNAME, MASTER_ADMIN_PASSWORD
 *
 * Requires the same env the API uses: DATABASE_URL + KEYCLOAK_* (admin client).
 * Re-running is safe — it fills gaps and never duplicates.
 */
async function main() {
  const cfg = MasterOrgInitService.readConfig();
  const app = await NestFactory.createApplicationContext(MasterOrgInitModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const svc = app.get(MasterOrgInitService);
    const result = await svc.run(cfg);

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '════════════════════════════════════════════════════════════════',
        '  MASTER ORG READY',
        '════════════════════════════════════════════════════════════════',
        `  Organization : ${cfg.name}  (alias: ${result.alias})`,
        `  Plan         : ${cfg.plan}`,
        `  Tenant ID    : ${result.tenantId}`,
        `  KC Org ID    : ${result.keycloakOrgId}`,
        `  Admin email  : ${result.adminEmail}`,
        `  Admin userId : ${result.userId}`,
        `  platformRole : SUPER_ADMIN  (manager-api/web access)`,
        `  Tenant role  : OWNER        (full CRM access)`,
        '',
        result.generatedPassword
          ? `  ⚠ GENERATED PASSWORD (shown ONCE — save to your password manager):\n      ${result.generatedPassword}`
          : '  ℹ Existing Keycloak user reused — password left unchanged.',
        '',
        `  CRM login     : ${result.loginUrls.crm}`,
        `  Manager login : ${result.loginUrls.manager}`,
        '════════════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[init-master-org] FAILED:', err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
