# Accounts Module — Technical Reference

**Path:** `src/accounts/`  
**Module class:** `AccountsModule`

```
accounts/
├── accounts.controller.ts
├── accounts.service.ts
├── accounts.module.ts
├── domain/account.ts
├── dto/
│   ├── create-account.dto.ts
│   ├── update-account.dto.ts
│   └── query-account.dto.ts
└── infrastructure/persistence/document/
    ├── entities/account.schema.ts
    └── repositories/account.repository.ts
```

---

## 1. Domain Model (collection: `accounts`)

```typescript
Account {
  id: string;
  tenantId: string;              // Immutable
  name: string;                  // Company name
  domain?: string;               // Website domain (e.g. 'acme.com')
  industry?: string;
  size?: string;                 // Company size bucket
  emails: string[];
  phones: string[];
  address?: {
    street?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
  ownerId?: string;              // Assigned account manager
  tags: string[];
  customFields: Record<string, any>;
  createdById?: string;
  createdAt, updatedAt: Date;
  deletedAt?: Date;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, deletedAt: 1, createdAt: -1 }
{ tenantId: 1, name: 1 }
{ tenantId: 1, domain: 1 }
Text index: { name, domain, emails }
```

---

## 2. Service Methods

`AccountsService` provides standard CRUD. Pagination supports **both** modes:

```typescript
findAll(filter):
  if filter.cursor:
    → cursor pagination (findManyWithCursorPagination)
  else:
    → offset pagination (findManyWithPagination)
```

Cursor pagination uses `DEFAULT_CURSOR_COUNT_LIMIT` for total count (capped to avoid expensive count queries on large collections).

---

## 3. Account Settings (`account-settings/`)

**Path:** `src/account-settings/`  
Configures custom fields and display options for account records per tenant.

---

## 4. API Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/accounts` | `accounts:view` | List accounts (offset or cursor pagination) |
| `POST` | `/api/v1/accounts` | `accounts:create` | Create account |
| `GET` | `/api/v1/accounts/:id` | `accounts:view` | Get account |
| `PATCH` | `/api/v1/accounts/:id` | `accounts:edit` | Update account |
| `DELETE` | `/api/v1/accounts/:id` | `accounts:delete` | Soft delete |

---

## 5. Relation to Contacts & Deals

- A `Contact` can reference an `accountId` → many contacts per account
- A `Deal` can reference an `accountId` → many deals per account
- Account deletion does **not** cascade — related contacts/deals retain the `accountId` reference (orphan-safe)
