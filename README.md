# crm-api — Core Backend API

> **Last updated:** 2026-06-14  
> **Stack:** NestJS 10 · MongoDB 7 (Mongoose) · Redis 7 (ioredis) · Keycloak 26 · BullMQ · Socket.IO  
> **Runtime:** Node.js 20+  
> **Port:** 3000 (default)

---

## Quick Start

```bash
cp .env.example .env
# Edit .env — minimum required: MONGODB_URI, REDIS_*, KEYCLOAK_*

npm install
npm run start:dev
```

- **API:** `http://localhost:3000/api/v1/`
- **Swagger:** `http://localhost:3000/docs`
- **BullBoard:** `http://localhost:3000/queues` (SUPER_ADMIN only)

---

## Technical Documentation

> **[→ Full API Technical Docs](./docs/README.md)**

| Module | Docs | Source Path |
|---|---|---|
| Auth & RBAC | [01-auth.md](./docs/01-auth.md) | `src/auth/`, `src/common/permissions/` |
| Channels | [02-channels.md](./docs/02-channels.md) | `src/channels/` |
| Contacts | [03-contacts.md](./docs/03-contacts.md) | `src/contacts/` |
| Accounts | [04-accounts.md](./docs/04-accounts.md) | `src/accounts/` |
| Deals | [05-deals.md](./docs/05-deals.md) | `src/deals/`, `src/deal-settings/` |
| Tickets | [06-tickets.md](./docs/06-tickets.md) | `src/tickets/`, `src/ticket-settings/` |
| Social Posts | [07-social-posts.md](./docs/07-social-posts.md) | `src/social-posts/` |
| AI Video | [08-ai-video.md](./docs/08-ai-video.md) | `src/ai-video/` |
| Omni-channel Inbox | [09-omni-inbound.md](./docs/09-omni-inbound.md) | `src/omni-inbound/`, `src/omni-outbound/` |
| Users, Groups & Tasks | [10-users-groups-tasks.md](./docs/10-users-groups-tasks.md) | `src/users/`, `src/groups/`, `src/tasks/` |
| Tenants & Onboarding | [11-tenants.md](./docs/11-tenants.md) | `src/tenants/`, `src/crm-settings/` |
| Queue & Workers | [12-queue.md](./docs/12-queue.md) | `src/queue/` |
| Automation, Routing, SLA | [13-automation-routing-sla.md](./docs/13-automation-routing-sla.md) | `src/automation-rules/`, `src/routing-rules/`, `src/sla-policies/`, `src/canned-responses/`, `src/notes/` |
| Observability & Infrastructure | [14-observability-infrastructure.md](./docs/14-observability-infrastructure.md) | `src/audit-log/`, `src/activity-log/`, `src/custom-fields/`, `src/redis/`, `src/mail/` |
| Cloud Drive & File Management | [18-cloud-drive.md](./docs/18-cloud-drive.md) | `src/files/` |

---

## Architecture

### Request Lifecycle

```
HTTP Request
  │
  ├─ TenantResolverMiddleware  → req.tenantAlias = subdomain
  ├─ HybridAuthGuard           → validates sid cookie or Bearer JWT
  ├─ TenantInterceptor         → cls.set('tenantId')
  ├─ MaintenanceModeGuard      → 503 if tenant.maintenanceMode
  ├─ PermissionGuard           → enforces @RequirePermission(action, resource)
  └─ Controller → Service → Repository (all queries auto-scoped by tenantId)
```

### Key Infrastructure

| Component | Technology | Purpose |
|---|---|---|
| Database | MongoDB (Mongoose) | Primary data store |
| Cache | Redis + ioredis | Sessions, permission cache, OAuth state |
| Queue | BullMQ on Redis | Social publishing, export, email |
| Real-time | Socket.IO + Redis adapter | Live ticket/message updates |
| Auth | Keycloak OIDC | SSO, JWT, JIT user provisioning |
| Context | nestjs-cls (CLS) | tenantId/userId across async request scope |
| Logging | Winston | Structured logging with correlation IDs |

### Worker Mode

Run as a BullMQ-only process (no HTTP server):
```bash
RUNTIME_ROLE=worker npm run start:dev
```

---

## Development

```bash
npm run start:dev        # Development with hot reload
npm run test             # Unit tests
npm run test:e2e         # E2E tests
npm run test:cov         # Coverage report
npm run lint             # ESLint
npm run build            # Production build
npm run start:prod       # Run production build
```

---

## Environment Variables

Copy `.env.example` to `.env`. Required variables:

```bash
# Server
PORT=3000
NODE_ENV=development

# Database
MONGODB_URI=mongodb://localhost:27017/crm

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Keycloak — user-facing auth
KEYCLOAK_AUTH_SERVER_URL=http://localhost:8080
KEYCLOAK_REALM=crm
KEYCLOAK_CLIENT_ID=crm-api
KEYCLOAK_CLIENT_SECRET=<secret>
KEYCLOAK_CALLBACK_URL=http://localhost:3000/api/v1/auth/callback
KEYCLOAK_FRONTEND_URL=http://localhost:5173

# Keycloak — admin API (for user provisioning)
KEYCLOAK_ADMIN_CLIENT_ID=crm-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=<secret>

# Domain routing
APP_ROOT_DOMAIN=localhost
FRONTEND_DOMAIN=http://localhost:5173
BACKEND_DOMAIN=http://localhost:3000

# Meta / Facebook integration
FACEBOOK_APP_ID=<app_id>
FACEBOOK_APP_SECRET=<app_secret>

# AI features (optional)
OPENAI_API_KEY=sk-...          # AI Video caption generation
ELEVENLABS_API_KEY=<key>       # Voice synthesis for AI Video

# Worker mode
RUNTIME_ROLE=api               # 'api' or 'worker'

# Permission cache TTL (optional)
AUTHZ_PERMISSION_CACHE_TTL_SECONDS=300
```

---

## Docker

```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.production.yaml up -d --build
```

---

## API Conventions

| Convention | Detail |
|---|---|
| Base path | `/api/v1/` |
| Versioning | URI-based (`/api/v1/`, `/api/v2/`) |
| Auth | HTTP-only `sid` cookie (BFF pattern) |
| Tenant | Resolved from subdomain → `tenantId` in CLS |
| Permissions | `@RequirePermission(action, resource)` on all protected routes |
| Pagination | Offset `?page&limit` or cursor `?cursor&direction` |
| Idempotency | `X-Idempotency-Key` header on POST |
| IDs | MongoDB ObjectId serialized as hex string (`id`, not `_id`) |
| Dates | ISO 8601 UTC strings |
| Errors | `{ statusCode, message, error, correlationId }` |
