import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

/**
 * Schemas intentionally scoped outside the generic request plugin. Each is an
 * append-only/system-worker store whose service owns explicit tenant filters.
 * Adding an entry is a security review; new tenant schemas fail by default.
 */
const REVIEWED_EXEMPTIONS = new Set([
  'ai-video/infrastructure/persistence/document/entities/ai-video-asset.schema.ts',
  'ai-video/infrastructure/persistence/document/entities/ai-video-audit-log.schema.ts',
  'ai-video/infrastructure/persistence/document/entities/ai-video-job.schema.ts',
  'ai-video/infrastructure/persistence/document/entities/ai-video-settings.schema.ts',
  'assignment/infrastructure/persistence/assignment-audit-archive.schema.ts',
  'audit-log/entities/audit-log.schema.ts',
  'channels/infrastructure/persistence/document/entities/email-content.schema.ts',
  'channels/infrastructure/persistence/document/entities/email-metadata.schema.ts',
  'channels/infrastructure/persistence/document/entities/email-provider-label.schema.ts',
  'common/authz-audit/authz-audit-log.schema.ts',
  'dashboards/dashboard.schema.ts',
  'files/infrastructure/persistence/document/entities/file.schema.ts',
  'files/infrastructure/persistence/document/entities/folder.schema.ts',
  'livechat/infrastructure/persistence/document/entities/widget-event.schema.ts',
  'omni-inbound/infrastructure/persistence/document/entities/agent-state-segment.schema.ts',
  'omni-inbound/infrastructure/persistence/document/entities/agent-status-audit-log.schema.ts',
  'omni-inbound/infrastructure/persistence/document/entities/interaction-segment.schema.ts',
  'omni-inbound/infrastructure/persistence/document/entities/outbox-event.schema.ts',
  'omni-inbound/infrastructure/persistence/document/entities/processed-operation.schema.ts',
  'tenants/infrastructure/persistence/document/entities/provisioning-job.schema.ts',
]);

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.schema.ts') ? [full] : [];
  });

describe('tenant schema inventory', () => {
  it('requires tenant plugin or an exact reviewed exemption', () => {
    const violations = walk(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (!/\btenantId\b/.test(source)) return false;
        if (/\.plugin\(tenantFilterPlugin/.test(source)) return false;
        const relative = path.relative(SRC, file).replaceAll('\\', '/');
        return !REVIEWED_EXEMPTIONS.has(relative);
      })
      .map((file) => path.relative(SRC, file).replaceAll('\\', '/'));

    expect(violations).toEqual([]);
  });

  it('keeps every exemption alive and explicit (no stale allowlist entries)', () => {
    for (const relative of REVIEWED_EXEMPTIONS) {
      const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
      expect(source).toMatch(/\btenantId\b/);
      expect(source).not.toMatch(/\.plugin\(tenantFilterPlugin/);
    }
  });
});
