# Tickets Module — Technical Reference

**Path:** `src/tickets/`  
**Module class:** `TicketsModule`

---

## 1. Domain Model (collection: `tickets`)

```typescript
Ticket {
  id: string;
  tenantId: string;                  // Immutable
  ticketNumber: number;              // Auto-incremented per tenant (sequential)
  subject?: string;
  statusId: string;                  // From TicketSettings
  priorityId?: string;               // From TicketSettings
  typeId?: string;                   // From TicketSettings
  channelId?: string;                // Source channel
  channelType?: string;              // 'facebook' | 'instagram' | 'whatsapp' | 'email'
  contactId?: string;
  accountId?: string;
  ownerId?: string;                  // Assigned agent
  groupId?: string;                  // Assigned group
  tags: string[];
  customFields: Record<string, any>;
  isSlaBreached: boolean;            // Default: false
  timeSpentSeconds: number;          // Default: 0
  firstRepliedAt?: Date;
  resolvedAt?: Date;                 // Auto-set when status becomes terminal
  closedAt?: Date;                   // Auto-set when status becomes terminal
  createdById?: string;
  createdAt, updatedAt: Date;
  deletedAt?: Date;
}
```

**MongoDB indexes:**
```
{ tenantId: 1, statusId: 1, createdAt: -1 }
{ tenantId: 1, ownerId: 1, statusId: 1 }
{ tenantId: 1, groupId: 1 }
{ tenantId: 1, contactId: 1 }
{ tenantId: 1, ticketNumber: 1 }   — unique per tenant
```

---

## 2. Ticket Number Generation

`TicketRepository.generateTicketNumber()`:
```
db.tickets.findOneAndUpdate(
  { tenantId },
  { $inc: { seq: 1 } },
  { upsert: true, returnDocument: 'after' }
)
→ ticket.ticketNumber = seq value
```
Uses a separate `ticket_sequences` collection to maintain atomic sequence per tenant.

---

## 3. Terminal Status Auto-Timestamps

In `TicketsService.update()`, when `statusId` is changed:
```typescript
status = await ticketSettingsService.findStatusById(data.statusId)
if (status?.isTerminal):
  updateData.resolvedAt = data.resolvedAt ?? new Date()
  updateData.closedAt   = data.closedAt   ?? new Date()
```
`isTerminal` is a configurable flag on the status in `TicketSettings`.

---

## 4. Ticket Settings Module (`ticket-settings/`)

**Path:** `src/ticket-settings/`

```typescript
TicketSettings {
  tenantId: ObjectId;
  statuses: TicketStatus[];     // e.g. Open, Pending, Resolved (isTerminal: true), Closed
  priorities: Priority[];       // e.g. Low, Medium, High, Urgent
  types: TicketType[];          // e.g. Question, Bug, Feature Request
}

TicketStatus {
  id: string;
  label: string;
  color: string;
  isTerminal: boolean;          // True → auto-set resolvedAt/closedAt
  isDefault: boolean;
}
```

---

## 5. Relation to Omni-Inbound

Tickets are the **central entity** in the omni-channel inbox. The `OmniInboundModule` creates tickets automatically:
- Each unique sender conversation = one ticket
- Inbound messages are appended to the open ticket as `OmniMessage` records
- Ticket is closed/resolved when the conversation ends

See [06-omni-inbound.md](./06-omni-inbound.md) for the full conversation flow.

---

## 6. API Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/tickets` | `tickets:view` | List tickets (filter by status, owner, group, channel) |
| `POST` | `/api/v1/tickets` | `tickets:create` | Create ticket manually |
| `GET` | `/api/v1/tickets/:id` | `tickets:view` | Get ticket |
| `PATCH` | `/api/v1/tickets/:id` | `tickets:edit` | Update (assignment, status, etc.) |
| `DELETE` | `/api/v1/tickets/:id` | `tickets:delete` | Delete |

---

## 7. Automation Events

| Event | Emitted when |
|---|---|
| `record_created.Ticket` | New ticket created |
| `field_updated.Ticket` | Ticket fields changed (includes `changedFields` list) |
