# Tasks Module — Technical Reference

**Path:** `src/tasks/`  
**Module class:** `TasksModule`

---

## 1. Domain Model (collection: `tasks`)

```typescript
Task {
  id: string;
  tenantId: string;              // Immutable
  title: string;
  description?: string;
  statusId?: string;             // From TaskSettings
  categoryId?: string;           // From TaskSettings
  priorityId?: string;
  ownerId?: string;              // Assigned user
  dueDate?: Date;
  completedAt?: Date;
  relatedTo?: {
    type: 'contact' | 'deal' | 'account' | 'ticket';
    id: string;
  };
  tags: string[];
  customFields: Record<string, any>;
  createdById?: string;
  createdAt, updatedAt: Date;
  deletedAt?: Date;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, ownerId: 1, statusId: 1, dueDate: 1 }
{ tenantId: 1, 'relatedTo.type': 1, 'relatedTo.id': 1 }
{ tenantId: 1, dueDate: 1 }   — for upcoming tasks view
```

---

## 2. Task Settings (`task-settings/`)

**Path:** `src/task-settings/`

```typescript
TaskSettings {
  tenantId: ObjectId;
  statuses: TaskStatus[];     // e.g. Todo, In Progress, Done
  categories: TaskCategory[]; // e.g. Call, Meeting, Email, Follow-up
}
```

---

## 3. API Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/tasks` | `tasks:view` | List tasks (filter by owner, status, due date) |
| `POST` | `/api/v1/tasks` | `tasks:create` | Create task |
| `GET` | `/api/v1/tasks/:id` | `tasks:view` | Get task |
| `PATCH` | `/api/v1/tasks/:id` | `tasks:edit` | Update (including status, owner) |
| `DELETE` | `/api/v1/tasks/:id` | `tasks:delete` | Delete |

---

# Users & Groups Module — Technical Reference

**Path:** `src/users/`, `src/groups/`  
**Module classes:** `UsersModule`, `GroupsModule`

---

## User Domain Model (collection: `users`)

```typescript
User {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;              // Global unique
  password?: string;                 // bcrypt hashed (not used if Keycloak)
  photo?: FileType;
  keycloakId?: string;               // Keycloak user UUID
  provider: 'email' | 'google' | 'facebook';
  platformRole: { id: PlatformRoleEnum };  // SUPER_ADMIN | USER
  status: { id: StatusEnum };              // 'active' | 'inactive'
  
  // Multi-tenant membership
  tenants: UserTenantMembership[];
  
  // Omni-channel agent config
  omniMaxCapacity?: number;          // Max concurrent conversations
  skills?: string[];                 // Used by routing rules
  
  // i18n preferences
  i18nPreferences?: {
    locale?: string | null;
    timezone?: string | null;
  };
  
  createdAt, updatedAt: Date;
}

UserTenantMembership {
  tenantId: string;
  roles: string[];                   // ['OWNER'] | ['ADMIN'] | ['MEMBER']
  permissions: string[];             // Per-user direct permission grants
  permissionOverrides: Record<string, boolean>; // True=grant, False=revoke
  joinedAt: Date;
}
```

**MongoDB indexes:**
```
{ email: 1 }                        — unique (sparse)
{ keycloakId: 1, provider: 1 }     — unique (sparse)
{ 'tenants.tenantId': 1 }          — tenant membership lookup
```

---

## `UsersService` Key Methods

| Method | Description |
|---|---|
| `invite(dto)` | Invite user: create in Keycloak + add tenant membership (handles existing users) |
| `createForTenant(dto)` | Create + provision in Keycloak + add to KC org + send password reset email |
| `removeFromTenant(userId)` | Remove from all groups + remove tenant membership + invalidate permission cache |
| `update(id, dto)` | Update profile fields; emits `user.permissions.updated` to invalidate cache |
| `updateStatus(id, status)` | Sync enabled/disabled to Keycloak + local DB |
| `resetPassword(id)` | Triggers Keycloak `executeActionsEmail(['UPDATE_PASSWORD'])` |
| `getUserGroups(userId)` | List groups the user belongs to in current tenant |
| `getResolvedI18n(userId, tenantId)` | Merge user prefs + tenant defaults + system defaults |
| `checkEmail(email)` | Global email existence check (for onboarding/invite flows) |

### Invite Flow Detail

```
invite({ email, tenantRole }) → User:

Case 1 — User already in system:
  1. Check user not already in tenant → 422 if duplicate
  2. keycloakAdminService.addUserToOrganization(kcOrgId, user.keycloakId)
  3. usersRepository.upsertWithTenants → add tenant membership
  4. emit 'user.tenant-membership.updated'

Case 2 — New user:
  1. keycloakAdminService.findUserByEmail → null
  2. keycloakAdminService.createUser(email, tmpPassword, email)
  3. keycloakAdminService.addUserToOrganization
  4. keycloakAdminService.resetPassword → send "Set password" email
  5. usersRepository.create with tenant membership
  6. On DB error → ROLLBACK: keycloakAdminService.deleteUser
```

---

## Groups Domain Model (collection: `groups`)

```typescript
Group {
  id: string;
  tenantId: string;          // Immutable
  name: string;
  description?: string;
  keycloakGroupId?: string;  // Linked Keycloak group
  memberIds: string[];       // User IDs
  permissions: string[];     // Permission keys granted to all members
  createdAt, updatedAt: Date;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, name: 1 }     — unique per tenant
{ tenantId: 1, memberIds: 1 } — member lookup
```

**Permission inheritance:** `group.permissions[]` is intersected with `tenant.availablePermissions` (ceiling) — see [01-auth.md](./01-auth.md) permission engine.

---

## API Endpoints — Users

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/users` | `users:view` | List users in tenant |
| `POST` | `/api/v1/users` | `users:create` | Create user (Keycloak provisioned) |
| `POST` | `/api/v1/users/invite` | `users:create` | Invite existing or new user |
| `GET` | `/api/v1/users/:id` | `users:view` | Get user |
| `PATCH` | `/api/v1/users/:id` | `users:edit` | Update user |
| `DELETE` | `/api/v1/users/:id` | `users:delete` | Remove from tenant |
| `POST` | `/api/v1/users/:id/reset-password` | `users:manage_roles` | Send password reset email |
| `GET` | `/api/v1/users/:id/groups` | `users:view` | User's groups in tenant |
| `GET` | `/api/v1/users/check-email` | Session | Global email existence check |
| `GET` | `/api/v1/users/i18n` | Session | Resolved i18n preferences |
| `PATCH` | `/api/v1/users/i18n` | Session | Update i18n preferences |

## API Endpoints — Groups

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/groups` | `groups:view` | List groups |
| `POST` | `/api/v1/groups` | `groups:create` | Create group (also creates Keycloak group) |
| `GET` | `/api/v1/groups/:id` | `groups:view` | Get group |
| `PATCH` | `/api/v1/groups/:id` | `groups:edit` | Update group / permissions |
| `DELETE` | `/api/v1/groups/:id` | `groups:delete` | Delete group |
| `POST` | `/api/v1/groups/:id/members` | `groups:manage_members` | Add member |
| `DELETE` | `/api/v1/groups/:id/members/:userId` | `groups:manage_members` | Remove member |

---

## Events Emitted

| Event | Trigger | Consumer |
|---|---|---|
| `user.permissions.updated` | User update / status change | `AuthzPermissionCacheService.invalidateUser()` |
| `user.tenant-membership.updated` | Invite / removeFromTenant | `AuthzPermissionCacheService.invalidateUser()` |
