# Tenants & Multi-Tenancy — Technical Reference

**Path:** `src/tenants/`  
**Module class:** `TenantsModule`, `OnboardingModule`

---

## 1. Tenant Schema (collection: `tenants`)

```typescript
Tenant {
  id: string;                    // ObjectId
  name: string;
  alias: string;                 // Subdomain — unique, immutable after creation
  ownerId?: string;              // Ref: users — the account owner

  // Keycloak
  keycloakOrgId?: string;        // Keycloak Organization ID

  // Subscription
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
  status: 'active' | 'suspended' | 'cancelled';
  availablePermissions?: string[];     // Feature-tier permission overrides
  disabledCorePermissions?: string[];  // Remove specific CORE permissions

  // Settings
  timezone: string;
  locale: string;
  logo?: string;
  maintenanceMode: boolean;

  createdAt, updatedAt: Date;
}

// MongoDB indexes:
{ alias: 1 }                      — unique
{ keycloakOrgId: 1 }              — unique (sparse)
{ status: 1 }
```

---

## 2. Tenant Resolution Middleware

**File:** `src/tenants/middleware/tenant-resolver.middleware.ts`

Runs **before every request** (applied globally in `AppModule`):

```typescript
TenantResolverMiddleware.use(req, res, next):
  host = req.headers.host || req.hostname  // e.g. 'acme.crmsaudi.dev'
  rootDomain = configService.get('app.rootDomain')  // 'crmsaudi.dev'

  if host.endsWith('.' + rootDomain):
    alias = host.split('.')[0]             // 'acme'
  else:
    alias = null

  req.tenantAlias = alias
  next()
```

Then `TenantInterceptor` (APP_INTERCEPTOR) resolves the alias to a tenant ID:

```typescript
TenantInterceptor.intercept(ctx, next):
  alias = request.tenantAlias
  if alias:
    tenant = await tenantsRepository.findByAlias(alias)
    if !tenant → throw NotFoundException('Tenant not found')
    cls.set('tenantId', tenant.id)
    cls.set('tenantAlias', alias)
  return next.handle()
```

**CLS flow:** `tenantId` is available throughout the request via `ClsService.get('tenantId')`.

---

## 3. Tenant Settings (`TenantSettings`)

**File:** `src/tenants/domain/tenant-settings.ts`  
**Controller:** `tenant-settings.controller.ts` — `/api/v1/tenants/me/settings`

Structured settings stored as a flat `Record<string, any>` on the tenant document. Key namespaces:

| Key | Description |
|---|---|
| `contact_lifecycle` | Lifecycle stages and statuses configuration |
| `contact_access` | `{ restrictOwnContacts: boolean }` |
| `deal_pipeline` | Deal pipeline stages |
| `ticket_settings` | Ticket types, priorities |
| `branding` | Logo, colors |
| `notifications` | Notification preferences |

---

## 4. Onboarding Module (`onboarding.module.ts`)

Handles new tenant provisioning for users who have authenticated with Keycloak but have no tenant.

### Flow

```
1. User authenticates → no tenantId in claims
2. Frontend redirects to: /onboarding

3. POST /api/v1/onboarding/create
   {
     companyName: string,
     alias: string,      // desired subdomain
     timezone: string,
   }

4. OnboardingService.createTenant(dto):
   a. Validate alias uniqueness (case-insensitive, alphanumeric + hyphens)
   b. Create Tenant record in MongoDB
   c. tenantsRepository.create({ name, alias, ownerId: userId, status: 'active' })
   d. Create default CrmSettings for tenant (lifecycle stages, etc.)
   e. KeycloakAdminService.createOrganization(name, alias)
      → stores keycloakOrgId on tenant
   f. KeycloakAdminService.addUserToOrganization(keycloakOrgId, keycloakUserId)
   g. Update user.tenants[] with new membership (role: 'OWNER')
   h. authzPermissionCache.invalidateUser(tenantId, userId)

5. POST /api/v1/onboarding/complete
   → Marks onboarding session complete
   → Returns redirect URL: https://{alias}.{rootDomain}
```

### Onboarding Session

Special session state (no tenantId, no JWT token):
```typescript
// HybridAuthGuard special case for onboarding routes:
if session.idToken === undefined && isOnboardingRoute(request):
  request.user = { id: session.userId, sub: session.userId }
  // No tenant in context — allowed only on /onboarding/* routes
```

---

## 5. Maintenance Mode

**Guard:** `MaintenanceModeGuard` (applied globally as `APP_GUARD`)

```typescript
canActivate(context):
  tenantId = cls.get('tenantId')
  if !tenantId → skip (public routes)

  tenant = await tenantsRepository.findById(tenantId)
  if tenant.maintenanceMode:
    payload = request.user
    if hasSuperAdminClaim(payload) → allow (admin bypass)
    throw ServiceUnavailableException('Tenant is in maintenance mode')
  return true
```

**Activate maintenance mode:**
```
PATCH /api/v1/tenants/me
  { maintenanceMode: true }
  (requires settings:manage_system permission)
```

---

## 6. `TenantsService` Key Methods

| Method | Description |
|---|---|
| `findByAlias(alias)` | Lookup by subdomain |
| `findById(id)` | Single tenant |
| `create(dto)` | Create new tenant (used by OnboardingService) |
| `update(tenantId, dto)` | Update tenant fields |
| `updateSettings(tenantId, key, value)` | Upsert a settings namespace |
| `getSettings(tenantId, key)` | Read a settings namespace |
| `suspend(tenantId)` | Set status=suspended |
| `activate(tenantId)` | Set status=active |

---

## 7. Workers (`workers/`)

Background workers running on cron or event triggers:
- `TenantCleanupWorker` — removes expired/cancelled tenant data after grace period
- `TenantHealthWorker` — periodic check that all channels are healthy

---

## 8. CRM Settings Module

**Path:** `src/crm-settings/`  
**Purpose:** Per-tenant structured config (contact lifecycle, deal pipeline, etc.)

```typescript
// Collection: crm_settings
CrmSettings {
  tenantId: ObjectId;   // Unique
  key: string;          // Setting namespace, e.g. 'contact_lifecycle'
  value: any;           // JSON value
  updatedAt: Date;
}

// API:
GET  /api/v1/crm-settings/:key       — Read setting by key
PUT  /api/v1/crm-settings/:key       — Write setting
```

---

## 9. API Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/tenants/me` | Session | Get current tenant info |
| `PATCH` | `/api/v1/tenants/me` | `settings:manage_system` | Update tenant |
| `GET` | `/api/v1/tenants/me/settings/:key` | `settings:view` | Read settings namespace |
| `PUT` | `/api/v1/tenants/me/settings/:key` | `settings:manage_system` | Write settings |
| `POST` | `/api/v1/onboarding/create` | Onboarding session | Create tenant |
| `POST` | `/api/v1/onboarding/complete` | Onboarding session | Complete onboarding |
| `GET` | `/api/v1/onboarding/status/:jobId` | Onboarding session | Check provisioning status |
