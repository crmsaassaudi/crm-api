# crm-api — Technical Documentation Index

> **Stack:** NestJS 10 · MongoDB (Mongoose) · Redis (ioredis) · Keycloak 26 · BullMQ · Socket.IO  
> **Runtime:** Node.js 20+  
> **API prefix:** `/api/v1/`  
> **Swagger UI:** `GET /docs`  
> **BullBoard:** `GET /queues` (SUPER_ADMIN only)

---

## Module Reference

| # | File | Modules covered | Source paths |
|---|---|---|---|
| 01 | [01-auth.md](./01-auth.md) | Auth, Sessions, RBAC, Permission Engine | `src/auth/`, `src/common/permissions/` |
| 02 | [02-channels.md](./02-channels.md) | Channels, Meta OAuth | `src/channels/` |
| 03 | [03-contacts.md](./03-contacts.md) | Contacts, Lifecycle, PII, Export | `src/contacts/`, `src/contact-settings/` |
| 04 | [04-accounts.md](./04-accounts.md) | Accounts, Account Settings | `src/accounts/`, `src/account-settings/` |
| 05 | [05-deals.md](./05-deals.md) | Deals, Deal Pipeline Settings | `src/deals/`, `src/deal-settings/` |
| 06 | [06-tickets.md](./06-tickets.md) | Tickets, Ticket Settings, SLA integration | `src/tickets/`, `src/ticket-settings/` |
| 07 | [07-social-posts.md](./07-social-posts.md) | Social Content Studio, Publishing Pipeline | `src/social-posts/` |
| 08 | [08-ai-video.md](./08-ai-video.md) | AI Video, Voice Synthesis, FFmpeg | `src/ai-video/` |
| 09 | [09-omni-inbound.md](./09-omni-inbound.md) | Omni-channel Inbox, Assignment Engine, Bot, Real-time | `src/omni-inbound/`, `src/omni-outbound/`, `src/realtime/` |
| 10 | [10-users-groups-tasks.md](./10-users-groups-tasks.md) | Users, Groups, Tasks, Invite Flow | `src/users/`, `src/groups/`, `src/tasks/`, `src/task-settings/` |
| 11 | [11-tenants.md](./11-tenants.md) | Multi-tenancy, Onboarding, CRM Settings | `src/tenants/`, `src/crm-settings/` |
| 12 | [12-queue.md](./12-queue.md) | BullMQ Queue Registry, Worker Mode | `src/queue/` |
| 13 | [13-automation-routing-sla.md](./13-automation-routing-sla.md) | Automation Rules, Routing Rules, SLA, Escalation, Canned Responses, Notes | `src/automation-rules/`, `src/routing-rules/`, `src/sla-policies/`, `src/escalation-policies/`, `src/canned-responses/`, `src/notes/` |
| 14 | [14-observability-infrastructure.md](./14-observability-infrastructure.md) | Audit Log, Activity Log, Files, Custom Fields, Tags, List Views, Redis, Mail, i18n | `src/audit-log/`, `src/activity-log/`, `src/files/`, `src/custom-fields/`, `src/tags/`, `src/list-views/`, `src/redis/`, `src/mail/` |

---

## Architecture Quick Reference

### Request Lifecycle

```
HTTP Request
  │
  ├── TenantResolverMiddleware     → req.tenantAlias = 'acme' (from subdomain)
  ├── HybridAuthGuard              → validates sid cookie / Bearer JWT
  ├── TenantInterceptor            → cls.set('tenantId', '...')
  ├── MaintenanceModeGuard         → 503 if tenant.maintenanceMode
  ├── PermissionGuard              → checks @RequirePermission(action, resource)
  ├── Controller method
  │     └── Service
  │           └── Repository (MongoDB, always scoped by tenantId)
  └── Response
        ├── NormalizeIdInterceptor   → _id → id
        └── ClassSerializerInterceptor → @Exclude() sensitive fields
```

### ClsService Context Keys

| Key | Type | Set by |
|---|---|---|
| `tenantId` | string | TenantInterceptor / PermissionGuard |
| `userId` | string | PermissionGuard |
| `email` | string | PermissionGuard |
| `correlationId` | string | LoggingInterceptor |
| `activeTenantId` | string | PermissionGuard (same as tenantId) |
| `locale` | string | i18n middleware |

### MongoDB Conventions

- All schemas include `tenantId` as `required, indexed, immutable`
- All schemas use `EntityDocumentHelper` (maps `_id → id` in JSON)
- All schemas use `tenantFilterPlugin` (auto-appends `{ tenantId }` to every query)
- Soft deletes use `deletedAt?: Date` — queries include `{ deletedAt: null }`

### Permission System Summary

```
2-tier permission model:
  CORE permissions   → always available to tenant Owner/Admin
  FEATURE permissions → enabled per-tenant in tenant.availablePermissions[]

User effective permissions:
  if Owner or ADMIN role → all tenant permissions
  else → INTERSECT(group.permissions + user.permissions + overrides, tenantPermissions)

Cache: Redis Set per (tenantId × userId)
  Key: authz:t:{tenantId}:u:{userId}:perms
  TTL: 300s (configurable via AUTHZ_PERMISSION_CACHE_TTL_SECONDS)
```

### Error Response Format

```json
{
  "statusCode": 400,
  "message": "Descriptive error message",
  "error": "Bad Request",
  "correlationId": "01HXY..."
}
```

### API Conventions

| Convention | Detail |
|---|---|
| Base path | `/api/v1/` |
| Auth | HTTP-only `sid` cookie (BFF) or `Authorization: Bearer <token>` |
| Tenant scope | Resolved from subdomain → `tenantId` in CLS, applied to all queries |
| Pagination | Offset: `?page&limit` / Cursor: `?cursor&direction&sortBy&sortOrder` |
| Date format | ISO 8601 UTC strings |
| ID format | MongoDB ObjectId as 24-char hex string (field name: `id`, not `_id`) |
| Errors | `{ statusCode, message, error, correlationId }` |

---

## Source Directory Map

```
src/
├── accounts/               Account (company) records
├── account-settings/       Custom field config for accounts
├── activity-log/           Customer-facing activity timeline
├── ai-video/               AI Video pipeline (GPT + ElevenLabs + FFmpeg)
├── assignment-engine/      Shared assignment logic (also used by routing-rules)
├── audit-log/              System-wide audit trail
├── auth/                   Keycloak OAuth, sessions, JIT provisioning
├── automation-rules/       Event-driven automation workflows
├── canned-responses/       Agent quick-reply templates
├── channels/               Social/email channel management + Meta OAuth
├── common/                 Shared: permissions, guards, interceptors, plugins
├── config/                 App configuration types and loaders
├── contact-settings/       Contact custom fields + lifecycle settings
├── contacts/               Contact management (lifecycle, merge, export)
├── crm-settings/           Per-tenant structured CRM configuration
├── custom-fields/          Custom field definitions CRUD
├── data-visibility/        PII masking interceptor
├── deal-settings/          Deal pipeline configuration
├── deals/                  Deal / opportunity management
├── escalation-policies/    SLA escalation workflows
├── files/                  File upload and static serving
├── groups/                 Agent groups with permission grants
├── i18n/                   Internationalization
├── list-views/             Saved filter/column views
├── mail/                   Transactional email templates
├── mailer/                 nodemailer transport wrapper
├── notes/                  CRM record notes
├── observability/          Logging interceptor, correlation IDs
├── omni-inbound/           Omni-channel inbox (webhooks, conversations, messages)
├── omni-outbound/          Agent reply sending (FB Messenger, WhatsApp, etc.)
├── queue/                  BullMQ queue definitions
├── realtime/               Socket.IO adapter config (Redis)
├── redis/                  Redis client provider
├── roles/                  Platform role enums (SUPER_ADMIN, USER)
├── routing-rules/          Conversation routing configuration
├── sla-policies/           SLA threshold definitions and breach detection
├── social-posts/           Social Content Studio + publishing pipeline
├── statuses/               User account status enums
├── system-settings/        Global platform settings (SUPER_ADMIN only)
├── tags/                   Tag registry
├── task-settings/          Task status and category config
├── tasks/                  Task management
├── tenants/                Multi-tenant core + onboarding module
├── ticket-settings/        Ticket status, priority, type config
├── tickets/                Helpdesk ticket management
└── users/                  User management + invite flow
```
