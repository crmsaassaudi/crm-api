/**
 * Omni-channel authorization gate.
 *
 * The omni module reached the point where three separate layers all have to
 * agree before a conversation is readable or assignable:
 *
 *   1. RBAC          — `omni_channel:*`, not `contacts:*`
 *   2. Record-level  — `@UseAcl` + `@LoadResource`, which is what makes
 *                      ObjectACL and ABAC apply at all
 *   3. Channel pool  — the channel's support list, enforced server-side
 *
 * Each of those has already been silently absent once. This suite pins all
 * three: the first two by static analysis of the controller (no bootstrap, no
 * database — so it gates every PR in milliseconds), the third by exercising the
 * repository's scope logic directly.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ClsService } from 'nestjs-cls';
import { Types } from 'mongoose';
import { ConversationRepository } from '../../omni-inbound/repositories/conversation.repository';

const CONTROLLER_PATH = join(
  __dirname,
  '..',
  '..',
  'omni-inbound',
  'controllers',
  'omni.controller.ts',
);
const source = readFileSync(CONTROLLER_PATH, 'utf8');

/**
 * Split the controller into one block per HTTP handler: the decorators plus the
 * signature, up to the next handler. Crude, and deliberately so — a real parser
 * would be a dependency and a maintenance burden for a check whose whole value
 * is that it is cheap enough to always run.
 */
function handlerBlocks(): Array<{ route: string; block: string }> {
  const routeRe =
    /@(Get|Post|Put|Patch|Delete)\(\s*'([^']*)'\s*\)([\s\S]*?)(?=\n\s{2}@(?:Get|Post|Put|Patch|Delete)\(|\n\}\s*$)/g;
  const blocks: Array<{ route: string; block: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = routeRe.exec(source)) !== null) {
    blocks.push({
      route: `${match[1].toUpperCase()} ${match[2]}`,
      block: match[3],
    });
  }
  return blocks;
}

const BLOCKS = handlerBlocks();

/**
 * Handlers that mutate a single conversation and therefore must be
 * record-level gated. Matched on the route pattern rather than listed by name
 * so a new `PATCH conversations/:id/…` is caught the day it is added.
 */
const MUTATING_SINGLE_CONVERSATION =
  /^(POST|PATCH|DELETE) conversations\/:(id|convId)\//;

/**
 * Routes that touch one conversation but are deliberately NOT record-gated,
 * each with the reason. Anything else must carry `@UseAcl`.
 */
const RECORD_ACL_EXEMPT: Record<string, string> = {
  'POST conversations/:id/lock':
    'advisory edit lock — held in Redis, grants no data access on its own',
  'POST conversations/:id/lock/heartbeat': 'renews the advisory lock only',
  'DELETE conversations/:id/lock': 'releases the advisory lock only',
  'PATCH conversations/:id/read':
    'per-user read marker; a deny here would leave an unread badge nobody can clear',
};

describe('omni-channel authorization', () => {
  it('should find the conversation handlers to inspect', () => {
    // A regex that silently matches nothing would turn every assertion below
    // into a vacuous pass.
    expect(BLOCKS.length).toBeGreaterThan(20);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Layer 1 — resource RBAC
  // ────────────────────────────────────────────────────────────────────────

  describe('resource RBAC', () => {
    it('should gate every conversation route on omni_channel, never on contacts', () => {
      // Omni access used to ride on `contacts:view`, so anyone who could read
      // the CRM could read every inbox. The resource is the module itself.
      const offenders = BLOCKS.filter(({ block }) =>
        /@RequirePermission\([^)]*'contacts'/.test(block),
      ).map(({ route }) => route);

      expect(offenders).toEqual([]);
    });

    it('should declare a permission on every conversation route', () => {
      const undeclared = BLOCKS.filter(
        ({ block }) =>
          !/@RequirePermission\(/.test(block) && !/@Unprotected\(/.test(block),
      ).map(({ route }) => route);

      expect(undeclared).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Layer 2 — record-level ACL / ABAC
  // ────────────────────────────────────────────────────────────────────────

  describe('record-level ACL', () => {
    const mutating = BLOCKS.filter(({ route }) =>
      MUTATING_SINGLE_CONVERSATION.test(route),
    );

    it('should carry @UseAcl on every mutating single-conversation route', () => {
      const missing = mutating
        .filter(({ route }) => !(route in RECORD_ACL_EXEMPT))
        .filter(({ block }) => !/@UseAcl\(/.test(block))
        .map(({ route }) => route);

      expect(missing).toEqual([]);
    });

    it('should pair every @UseAcl with @LoadResource', () => {
      // Without the loader the guard has only `{id}` to decide on, so every
      // `resource.*` ABAC condition is structurally incapable of matching —
      // a policy that looks configured but can never fire.
      const unpaired = BLOCKS.filter(
        ({ block }) =>
          /@UseAcl\(/.test(block) && !/@LoadResource\(/.test(block),
      ).map(({ route }) => route);

      expect(unpaired).toEqual([]);
    });

    it('should load the omni_channel resource, matching the ACL resource name', () => {
      const mismatched = BLOCKS.filter(
        ({ block }) =>
          /@UseAcl\(/.test(block) &&
          !/@LoadResource\('omni_channel'\)/.test(block),
      ).map(({ route }) => route);

      expect(mismatched).toEqual([]);
    });

    it('should keep every ACL exemption pointing at a route that exists', () => {
      // A stale exemption is worse than none: it reads as a reviewed decision
      // while protecting nothing.
      const routes = new Set(BLOCKS.map(({ route }) => route));
      const stale = Object.keys(RECORD_ACL_EXEMPT).filter(
        (route) => !routes.has(route),
      );

      expect(stale).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Layer 3 — channel support pool
  // ────────────────────────────────────────────────────────────────────────

  describe('channel support pool enforcement', () => {
    it('should check eligibility on every assignment entry point', () => {
      const assignmentRoutes = [
        'PATCH conversations/:id/assign',
        'PATCH conversations/:id/claim',
        'POST conversations/:id/takeover',
      ];

      for (const route of assignmentRoutes) {
        const handler = BLOCKS.find((b) => b.route === route);
        expect(handler).toBeDefined();
        expect(handler!.block).toContain(
          'channelSupportService.assertAgentEligible',
        );
      }
    });

    it('should check the group as well when assigning to one', () => {
      const assign = BLOCKS.find(
        (b) => b.route === 'PATCH conversations/:id/assign',
      );
      expect(assign!.block).toContain(
        'channelSupportService.assertGroupEligible',
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Channel visibility axis (behavioural)
  // ────────────────────────────────────────────────────────────────────────

  describe('conversation visibility', () => {
    const CHANNEL_MINE = new Types.ObjectId().toString();
    const CHANNEL_OTHER = new Types.ObjectId().toString();
    const ME = new Types.ObjectId().toString();
    const COLLEAGUE = new Types.ObjectId().toString();

    /** A repository whose findById returns one fixed document. */
    function repoReturning(
      doc: Record<string, unknown>,
      cls: Record<string, unknown>,
    ) {
      const model: any = {
        findById: () => ({
          populate: () => ({
            populate: () => ({
              lean: () => ({ exec: () => Promise.resolve(doc) }),
            }),
          }),
        }),
      };
      const clsService = {
        get: (key: string) => cls[key],
        set: () => undefined,
      } as unknown as ClsService;

      return new ConversationRepository(model, clsService);
    }

    const conversation = (over: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      channelId: CHANNEL_MINE,
      assignedAgentId: ME,
      assignedGroupId: null,
      claimedById: null,
      ...over,
    });

    it('should hide a conversation on a channel the principal cannot serve', async () => {
      // Even though the owner axis admits it — the agent is assigned to it.
      const repo = repoReturning(conversation({ channelId: CHANNEL_OTHER }), {
        servableChannelIds: [CHANNEL_MINE],
        visibleOwnerIds: [ME],
      });

      await expect(repo.findById('x')).resolves.toBeNull();
    });

    it('should hide it on an unservable channel even with an unrestricted owner scope', async () => {
      // The two axes are independent: a TENANT-scope analyst is not thereby
      // admitted to a channel whose pool excludes them.
      const repo = repoReturning(conversation({ channelId: CHANNEL_OTHER }), {
        servableChannelIds: [CHANNEL_MINE],
        visibleOwnerIds: null,
      });

      await expect(repo.findById('x')).resolves.toBeNull();
    });

    it('should show it when both axes admit it', async () => {
      const repo = repoReturning(conversation(), {
        servableChannelIds: [CHANNEL_MINE],
        visibleOwnerIds: [ME],
      });

      await expect(repo.findById('x')).resolves.not.toBeNull();
    });

    it('should bypass the channel axis for an admin (servableChannelIds null)', async () => {
      const repo = repoReturning(conversation({ channelId: CHANNEL_OTHER }), {
        servableChannelIds: null,
        visibleOwnerIds: null,
      });

      await expect(repo.findById('x')).resolves.not.toBeNull();
    });

    it('should show a group-queued conversation to a member of that group', async () => {
      // The case that was invisible until auto-routing began persisting
      // `assignedGroupId`: owned by the team, picked up by nobody.
      const GROUP = new Types.ObjectId().toString();
      const repo = repoReturning(
        conversation({ assignedAgentId: null, assignedGroupId: GROUP }),
        {
          servableChannelIds: [CHANNEL_MINE],
          visibleOwnerIds: [ME],
          visibleGroupIds: [GROUP],
        },
      );

      await expect(repo.findById('x')).resolves.not.toBeNull();
    });

    it('should hide a group-queued conversation from a non-member', async () => {
      const repo = repoReturning(
        conversation({
          assignedAgentId: null,
          assignedGroupId: new Types.ObjectId().toString(),
        }),
        {
          servableChannelIds: [CHANNEL_MINE],
          visibleOwnerIds: [ME],
          visibleGroupIds: [],
        },
      );

      await expect(repo.findById('x')).resolves.toBeNull();
    });

    it('should hide a colleague-assigned conversation outside the owner scope', async () => {
      const repo = repoReturning(conversation({ assignedAgentId: COLLEAGUE }), {
        servableChannelIds: [CHANNEL_MINE],
        visibleOwnerIds: [ME],
      });

      await expect(repo.findById('x')).resolves.toBeNull();
    });

    it('should not evaluate either axis on the worker path (both unset)', async () => {
      // Queue processors run with no CLS visibility context. Applying a scope
      // there would silently drop inbound work.
      const repo = repoReturning(
        conversation({ channelId: CHANNEL_OTHER }),
        {},
      );

      await expect(repo.findById('x')).resolves.not.toBeNull();
    });
  });
});
