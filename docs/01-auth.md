# Auth Module — Technical Reference

**Path:** `src/auth/`  
**Module class:** `AuthModule`  
**Key files:**
```
auth/
├── auth.controller.ts          # HTTP endpoints
├── auth.service.ts             # Core OAuth orchestration
├── auth.module.ts
├── auth-providers.enum.ts
├── session-cookie.util.ts
├── guards/
│   └── hybrid-auth.guard.ts   # Session cookie + Keycloak Bearer fallback
├── services/
│   ├── session.service.ts     # Redis session CRUD + LRU in-memory cache
│   └── keycloak-admin.service.ts  # Keycloak Admin REST API client
├── dto/
│   └── auth-update.dto.ts
└── config/
    ├── auth.config.ts
    └── keycloak.config.ts
```

---

## 1. Authentication Flow

### 1.1 Login (Authorization Code + PKCE-like CSRF)

```
Client                  crm-api                  Keycloak              Redis
  │                        │                         │                    │
  │─ GET /auth/login ──────►│                         │                    │
  │                        │ buildLoginUrl()          │                    │
  │                        │  state = ulid()          │                    │
  │                        │  nonce = ulid()          │                    │
  │                        │─ SET oauth:state:<state> ──────────────────── ►│ TTL=5min
  │◄─ 302 Keycloak URL ────│                         │                    │
  │                        │                         │                    │
  │─ Authenticate ─────────────────────────────────► │                    │
  │◄─ 302 /auth/callback?code=&state= ──────────────┘                    │
  │                        │                         │                    │
  │─ GET /auth/callback ──► │                         │                    │
  │                        │ handleCallback()         │                    │
  │                        │  GET oauth:state:<state>────────────────────► │
  │                        │  DEL oauth:state:<state>────────────────────► │ (one-time)
  │                        │─ POST token?grant_type=authorization_code ──► │
  │                        │◄─ { access_token, refresh_token, id_token } ──│
  │                        │ decodeJwt(id_token)      │                    │
  │                        │ jitProvision(payload)    │                    │
  │                        │ createSession(tokens, userId)                  │
  │                        │─ SET session:<sid> ─────────────────────────► │ TTL=24h
  │◄─ Set-Cookie: sid ─────│                         │                    │
  │◄─ 302 tenant redirect ─│                         │                    │
```

**CSRF state payload** (stored in Redis as JSON):
```typescript
type OAuthStatePayload = {
  nonce: string;    // ULID — prevents replay
  returnTo?: string; // Sanitized redirect URL
}
```

### 1.2 Token Refresh (Auto, on every request)

`HybridAuthGuard.tryActivateSession()`:
1. Reads session from `SessionService.getSession(sid)` (LRU → Redis)
2. If `session.expiresAt - 30_000 <= Date.now()` → token is expiring
3. Calls `AuthService.refreshTokens(sid)` which:
   - Sets Redis lock `lock:auth:refresh:<sid>` (PX=10_000, NX) — prevents thundering herd
   - If lock acquired: `POST /token?grant_type=refresh_token`
   - If lock NOT acquired: polls `getSessionFresh()` for up to 10 seconds
4. Updates session in Redis with new tokens

### 1.3 Logout

```typescript
async logout(sid: string): Promise<void> {
  session = await sessionService.getSession(sid);
  await sessionService.deleteSession(sid);  // kills local session

  // Federated logout from Keycloak
  POST /realms/{realm}/protocol/openid-connect/logout
    { id_token_hint: session.idToken }
}
```

---

## 2. Session Service (`session.service.ts`)

**Storage:** Redis + LRU in-memory cache (1000 entries, 60s TTL)

```typescript
interface SessionData {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  userId: string;
  expiresAt: number;  // Unix ms — when access_token expires
}
```

**Redis key:** `session:<ulid>`  
**TTL:** 86,400 seconds (24h) — refreshed on each token renewal

| Method | Description |
|---|---|
| `createSession(tokens, userId)` | Generates ULID sid, writes to Redis + LRU |
| `getSession(sid)` | LRU hit first, then Redis fallback |
| `getSessionFresh(sid)` | Always reads from Redis (bypasses LRU) |
| `updateSession(sid, data, ttl)` | Overwrites Redis + refreshes LRU |
| `deleteSession(sid)` | DEL from Redis, evicts from LRU |

---

## 3. HybridAuthGuard (`guards/hybrid-auth.guard.ts`)

Extends `AuthGuard` from `nest-keycloak-connect`. Evaluated for **every protected route** as a global `APP_GUARD`.

**Decision tree:**
```
canActivate():
  1. isUnprotected decorator? → allow
  2. Extract sid candidates from cookies (handles encoded/raw values)
  3. For each sid candidate:
     a. getSession(sid)  → null? skip
     b. token expiring? → refreshTokens(sid)
     c. decodeJwt(idToken || accessToken) → set request.user
     d. return true
  4. No sid matched → delegate to Keycloak Bearer token validation
  5. No Bearer → 401 Unauthorized
```

**Special case — Onboarding routes:**  
Routes `/onboarding/context`, `/onboarding/complete`, `/onboarding/status/:id` accept sessions without an `idToken` (user has no tenant yet). The guard synthesizes a minimal `request.user = { id: session.userId, sub: session.userId }`.

---

## 4. JIT User Provisioning (`auth.service.ts → jitProvision()`)

Called on every callback and `/auth/me` request. Syncs Keycloak identity into MongoDB.

**Redis lock:** `lock:auth:sync:<keycloakId>` (PX=5000, NX) — prevents race on parallel logins.

**Algorithm:**
```
1. Look up user by keycloakId + provider='email'
2. If not found → look up by email (link existing user)
3. If not found → create user with tenant memberships from JWT claims
4. If found → diff JWT tenant claims vs stored tenants:
   - Remove memberships no longer in JWT
   - Add new memberships from JWT
   - Update keycloakId if changed
5. Tenant claims from JWT must be valid MongoDB ObjectIds (UUIDs rejected with warning)
```

---

## 5. Keycloak Admin Service (`services/keycloak-admin.service.ts`)

Uses `@keycloak/keycloak-admin-client` with **client credentials grant** (not user tokens).

**Auth:** `client_credentials` with `KEYCLOAK_ADMIN_CLIENT_ID` + `KEYCLOAK_ADMIN_CLIENT_SECRET`  
**Auto-retry:** On 401 or "Cannot refresh token" errors → re-authenticate then retry

| Method | Description |
|---|---|
| `createOrganization(name, alias)` | Creates Keycloak Organization (enables feature if disabled) |
| `deleteOrganization(orgId)` | Removes Keycloak Organization |
| `addUserToOrganization(orgId, userId)` | Adds member to org |
| `findUserByEmail(email)` | Exact-match search |
| `createUser(email, password, fullName)` | Creates user with emailVerified=true |
| `deleteUser(userId)` | Hard delete from Keycloak |
| `updateUserStatus(userId, enabled)` | Enable/disable user |
| `resetPassword(userId)` | Sends `UPDATE_PASSWORD` action email |
| `executeActionsEmail(userId, actions, redirectUri?)` | Triggers required actions email |
| `createGroup(name, attributes?)` | Creates Keycloak group |
| `addUserToGroup(userId, groupId)` | Adds user to group |

---

## 6. RBAC Permission System

### 6.1 Permission Constants (`common/permissions/permission.constants.ts`)

```typescript
// Full resource × action registry
PERMISSION_REGISTRY: {
  contacts: { view, create, edit, delete, export, import, unmask }
  deals:    { view, create, edit, delete, move_stage }
  tickets:  { view, create, edit, delete, resolve }
  tasks:    { view, create, edit, delete }
  ai_video: { view, create, edit, delete, manage_system }
  social_content_assets: { view, create, edit, delete, approve }
  publication_instances: { view, create, edit, cancel, retry, publish }
  users:    { view, create, edit, delete, manage_roles }
  groups:   { view, create, edit, delete, manage_members }
  settings: { view, manage_billing, manage_system }
  reports:  { view, create, export }
  campaigns:{ view, create, edit, delete, launch }
  accounts: { view, create, edit, delete, export }
  leads:    { view, create, edit, delete, export, import, assign }
}

// Permission key format: "resource:action" e.g. "contacts:view"
```

### 6.2 Permission Tiers

| Tier | Storage | Scope |
|---|---|---|
| **CORE** | Hardcoded in `CORE_PERMISSIONS[]` | Auto-granted to all tenant Owners/Admins |
| **FEATURE** | `tenant.availablePermissions[]` in MongoDB | Must be explicitly enabled per-tenant (e.g. campaigns, export) |
| **GROUP** | `group.permissions[]` in MongoDB | Granted to group members, intersected with tenant ceiling |
| **USER** | `user.tenants[].permissions[]` in MongoDB | Per-user grants, intersected with tenant ceiling |
| **OVERRIDE** | `user.tenants[].permissionOverrides{}` | True/false per-key, applied after group/user grants |

### 6.3 Permission Engine (`common/permissions/permission.engine.ts`)

```typescript
calculateEffectivePermissions(tenant, user, userGroups) → Set<string>

// Algorithm:
tenantPermissions = CORE_PERMISSIONS ∪ tenant.availablePermissions
                  - tenant.disabledCorePermissions

if (user is owner OR user has OWNER/ADMIN role):
  return tenantPermissions  // full access ceiling

// Regular member:
effectivePermissions = ∅
for group in userGroups:
  effectivePermissions ∪= group.permissions ∩ tenantPermissions
effectivePermissions ∪= membership.permissions ∩ tenantPermissions
for [key, granted] in membership.permissionOverrides:
  if key ∈ tenantPermissions:
    if granted: add key
    else: remove key
return effectivePermissions
```

### 6.4 Permission Cache (`common/permissions/authz-permission-cache.service.ts`)

**Redis key:** `authz:t:{tenantId}:u:{userId}:perms`  
**TTL:** `AUTHZ_PERMISSION_CACHE_TTL_SECONDS` env (default: 300s)  
**Storage:** Redis Set — each member is a permission key string

Special sentinels:
- `__all__` — Super Admin (has everything)
- `__empty__` — no permissions (prevents cache miss loop)

**Cache flow:**
```
canAccess(rawUserId, tenantHint, rule):
  1. SISMEMBER authz:t:{tenantId}:u:{userId}:perms {permissionKey}
  2. Cache hit → return allowed/denied
  3. Cache miss:
     a. Load user from MongoDB
     b. Resolve tenant (by ObjectId, alias, or keycloakOrgId)
     c. Load user groups
     d. calculateEffectivePermissions()
     e. SADD all keys to Redis (pipeline: DEL + SADD + EXPIRE)
     f. Check if permissionKey in Set
```

**Invalidation:**
- `invalidateUser(tenantId, userId)` → DEL single key
- `invalidateUsers(tenantId, userIds[])` → DEL multiple keys
- `invalidateTenant(tenantId)` → SCAN `authz:t:{tenantId}:u:*:perms` + DEL all

---

## 7. API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/auth/login` | Public | Redirect to Keycloak login |
| `GET` | `/api/v1/auth/callback` | Public | OAuth callback, set cookie |
| `POST` | `/api/v1/auth/logout` | Session | Delete session + federated logout |
| `GET` | `/api/v1/auth/me` | Session | Current user profile |
| `PATCH` | `/api/v1/auth/me` | Session | Update profile (name, photo) |
| `GET` | `/api/v1/auth/my-tenants` | Session | User's tenant memberships |
| `GET` | `/api/v1/auth/refresh` | Session | Force token refresh |

---

## 8. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `KEYCLOAK_AUTH_SERVER_URL` | ✅ | e.g. `https://auth.crmsaudi.dev` |
| `KEYCLOAK_REALM` | ✅ | e.g. `crm` |
| `KEYCLOAK_CLIENT_ID` | ✅ | API client ID |
| `KEYCLOAK_CLIENT_SECRET` | ✅ | API client secret |
| `KEYCLOAK_CALLBACK_URL` | ✅ | OAuth redirect URI |
| `KEYCLOAK_FRONTEND_URL` | ✅ | Post-login frontend base URL |
| `KEYCLOAK_ADMIN_CLIENT_ID` | ✅ | Admin API client ID |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | ✅ | Admin API client secret |
| `APP_ROOT_DOMAIN` | ✅ | Root domain for tenant subdomains |
| `AUTHZ_PERMISSION_CACHE_TTL_SECONDS` | ❌ | Default: 300 |
