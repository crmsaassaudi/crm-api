# Deals Module — Technical Reference

**Path:** `src/deals/`  
**Module class:** `DealsModule`

```
deals/
├── deals.controller.ts
├── deals.service.ts
├── deals.module.ts
├── constants/
├── domain/deal.ts
└── infrastructure/persistence/document/
    ├── entities/deal.schema.ts
    └── repositories/deal.repository.ts
```

---

## 1. Domain Model (collection: `deals`)

```typescript
Deal {
  id: string;
  tenantId: string;              // Immutable
  name: string;                  // alias: title
  title?: string;                // Mapped to name on create/update
  value?: number;                // Monetary value
  currency?: string;             // ISO 4217 code
  stageId: string;               // Pipeline stage key (from DealSettings)
  probability?: number;          // 0–100
  expectedCloseDate?: Date;
  ownerId?: string;              // Assigned sales rep
  contactId?: string;            // Linked contact
  accountId?: string;            // Linked account
  tags: string[];
  customFields: Record<string, any>;
  closedAt?: Date;
  createdById?: string;
  createdAt, updatedAt: Date;
  deletedAt?: Date;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, deletedAt: 1, stageId: 1, createdAt: -1 }
{ tenantId: 1, ownerId: 1 }
{ tenantId: 1, contactId: 1 }
{ tenantId: 1, accountId: 1 }
```

---

## 2. Service Logic

`DealsService` is intentionally thin — delegates entirely to `DealRepository`.

**Create/Update note:** Both `title` and `name` are accepted; `name = title || name` so both field names work transparently from the frontend.

**`ownerId` normalization:** If `ownerId === ''` → stored as `undefined` (prevents empty string FK).

---

## 3. Deal Settings Module (`deal-settings/`)

**Path:** `src/deal-settings/`  
**Purpose:** Configures the deal pipeline per tenant.

```typescript
// Collection: deal_settings (one doc per tenant)
DealSettings {
  tenantId: ObjectId;
  stages: DealStage[];
  currencies: CurrencyConfig[];
}

DealStage {
  id: string;           // e.g. 'qualified'
  label: string;        // Display name
  order: number;        // Position in pipeline
  probability: number;  // Default win probability (0–100)
  color: string;        // Hex color for kanban
  isWon?: boolean;      // True for 'Closed Won' stage
  isLost?: boolean;     // True for 'Closed Lost' stage
}
```

**API:**
```
GET  /api/v1/deal-settings          — Get pipeline config
PUT  /api/v1/deal-settings          — Save pipeline config (full replace)
POST /api/v1/deal-settings/stages   — Add a stage
DELETE /api/v1/deal-settings/stages/:id — Remove a stage
```

---

## 4. API Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/deals` | `deals:view` | List deals (filter by stage, owner, contact, account) |
| `POST` | `/api/v1/deals` | `deals:create` | Create deal |
| `GET` | `/api/v1/deals/:id` | `deals:view` | Get deal |
| `PATCH` | `/api/v1/deals/:id` | `deals:edit` | Update deal |
| `DELETE` | `/api/v1/deals/:id` | `deals:delete` | Soft delete |
| `POST` | `/api/v1/deals/:id/move-stage` | `deals:move_stage` | Change pipeline stage |

---

## 5. Automation Events

| Event | Emitted when |
|---|---|
| `record_created.Deal` | New deal created |
| `field_updated.Deal` | Deal fields changed |
