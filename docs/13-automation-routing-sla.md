# Automation Rules Module — Technical Reference

**Path:** `src/automation-rules/`  
**Module class:** `AutomationRulesModule`

---

## 1. Overview

Automation Rules allow tenants to define event-driven workflows without code. When certain CRM events occur (ticket created, contact field changed, etc.), matching rules execute a set of actions automatically.

---

## 2. Domain Model (collection: `automation_rules`)

```typescript
AutomationRule {
  id: string;
  tenantId: string;           // Immutable
  name: string;
  description?: string;
  isActive: boolean;          // Toggle without deleting
  
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  
  runCount: number;           // Total executions
  lastRunAt?: Date;
  createdAt, updatedAt: Date;
}

AutomationTrigger {
  event: 'record_created' | 'field_updated';
  object: 'Contact' | 'Ticket' | 'Deal' | 'Task';
}

AutomationCondition {
  field: string;              // e.g. 'statusId', 'priorityId', 'ownerId'
  operator: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty';
  value: any;
}

AutomationAction {
  type: ActionType;
  payload: Record<string, any>;
}

ActionType =
  | 'assign_to_agent'
  | 'assign_to_group'
  | 'change_status'
  | 'change_priority'
  | 'add_tag'
  | 'remove_tag'
  | 'send_email_notification'
  | 'create_task'
  | 'webhook'
```

---

## 3. Event Flow

```
TicketsService.create(ticket)
  → emits: EventEmitter2.emit('record_created.Ticket', AutomationEventPayload)

AutomationEventPayload {
  tenantId: string;
  event: 'record_created' | 'field_updated';
  object: 'Ticket' | 'Contact' | 'Deal' | 'Task';
  recordId: string;
  data: Record<string, any>;     // Full entity snapshot
  changedFields?: string[];      // Only for 'field_updated'
  automationDepth: number;       // Anti-loop counter (max 3)
}
```

**Anti-loop protection:** `automationDepth` increments each time an automation action triggers another event. Rules are skipped when `depth >= 3`.

---

## 4. Automation Listener (`automation-rules/listeners/`)

```typescript
@OnEvent('record_created.*')
@OnEvent('field_updated.*')
async handleEvent(payload: AutomationEventPayload):

  1. Load active rules for tenant where:
     trigger.event === payload.event AND
     trigger.object === payload.object

  2. For each rule:
     a. evaluateConditions(rule.conditions, payload.data)
        → all conditions must match (AND logic)

     b. If all match → executeActions(rule.actions, payload)
        → for each action, dispatch to ActionExecutorService

  3. Update rule.runCount++, rule.lastRunAt
```

---

## 5. Condition Evaluation

```typescript
evaluateCondition(condition, record):
  value = getNestedValue(record, condition.field)
  
  switch condition.operator:
    'equals':      return value === condition.value
    'not_equals':  return value !== condition.value
    'contains':    return String(value).includes(condition.value)
    'is_empty':    return !value || value === ''
    'is_not_empty': return !!value && value !== ''
```

---

## 6. Action Execution

Actions are executed sequentially. Failures are logged but do not stop subsequent actions.

| Action | Implementation |
|---|---|
| `assign_to_agent` | `ticketService.update(id, { ownerId })` |
| `assign_to_group` | `ticketService.update(id, { groupId })` |
| `change_status` | `ticketService.update(id, { statusId })` |
| `add_tag` | `repository.addTag(id, tag)` |
| `send_email_notification` | `mailQueueProducer.enqueue(template, recipients)` |
| `create_task` | `tasksService.create(taskData)` |
| `webhook` | `HTTP POST payload.url` with record data as JSON body |

---

## 7. API Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/automation-rules` | `settings:view` | List all rules |
| `POST` | `/api/v1/automation-rules` | `settings:manage_system` | Create rule |
| `GET` | `/api/v1/automation-rules/:id` | `settings:view` | Get rule |
| `PATCH` | `/api/v1/automation-rules/:id` | `settings:manage_system` | Update rule |
| `DELETE` | `/api/v1/automation-rules/:id` | `settings:manage_system` | Delete rule |
| `POST` | `/api/v1/automation-rules/:id/toggle` | `settings:manage_system` | Enable/disable |

---

# Routing Rules Module — Technical Reference

**Path:** `src/routing-rules/`

```typescript
RoutingRule {
  tenantId: ObjectId;
  name: string;
  isActive: boolean;
  priority: number;            // Lower = evaluated first

  conditions: {
    field: string;             // e.g. 'channelId', 'keyword', 'country'
    operator: string;
    value: any;
  }[];

  action: {
    type: 'assign_agent' | 'assign_group' | 'set_priority' | 'add_tag';
    targetId?: string;         // Agent or group ID
    priority?: string;
    tag?: string;
  };
}
```

**Evaluation:** In `AssignmentService.autoAssign()`:
1. Load `isActive` rules sorted by `priority ASC`
2. Evaluate conditions against conversation metadata
3. First matching rule's action is applied
4. If no rule matches → fallback to channel default assignment strategy

---

# Routing Rules API

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/routing-rules` | `settings:view` | List routing rules |
| `POST` | `/api/v1/routing-rules` | `settings:manage_system` | Create |
| `PATCH` | `/api/v1/routing-rules/:id` | `settings:manage_system` | Update |
| `DELETE` | `/api/v1/routing-rules/:id` | `settings:manage_system` | Delete |

---

# SLA Policies Module — Technical Reference

**Path:** `src/sla-policies/`

```typescript
SlaPolicy {
  tenantId: ObjectId;
  name: string;
  isDefault: boolean;
  conditions: SlaCondition[];    // When to apply this SLA
  
  firstReplyTimeMinutes: number;  // Breach if no reply within N minutes
  resolutionTimeMinutes: number;  // Breach if not resolved within N minutes
  
  businessHoursOnly: boolean;     // Only count business hours
}
```

**Breach detection:** Cron job (`sla-monitor.cron.ts`) runs every 5 minutes:
1. Find tickets with `resolvedAt = null` where SLA is active
2. Check `firstRepliedAt` and `createdAt` against SLA thresholds
3. Set `ticket.isSlaBreached = true` if exceeded

**API:**
```
GET  /api/v1/sla-policies
POST /api/v1/sla-policies
PATCH /api/v1/sla-policies/:id
DELETE /api/v1/sla-policies/:id
```

---

# Escalation Policies Module — Technical Reference

**Path:** `src/escalation-policies/`

Escalation policies define what happens when a ticket breaches its SLA:

```typescript
EscalationPolicy {
  tenantId: ObjectId;
  name: string;
  slaBreachTrigger: boolean;    // Trigger on SLA breach
  
  steps: EscalationStep[];
}

EscalationStep {
  delayMinutes: number;          // Wait N minutes after trigger
  action: {
    type: 'reassign_agent' | 'reassign_group' | 'send_notification' | 'change_priority';
    targetId?: string;
  };
}
```

---

# Canned Responses Module — Technical Reference

**Path:** `src/canned-responses/`

Pre-defined reply templates for agents in the omni-channel inbox:

```typescript
CannedResponse {
  tenantId: ObjectId;
  name: string;                  // Short name (e.g. 'greeting_en')
  shortCode: string;             // Type '/' to search — e.g. '/greet'
  content: string;               // Full response text
  tags: string[];
  createdById: ObjectId;
  isGlobal: boolean;             // Shared across all agents vs personal
}
```

**API:**
```
GET  /api/v1/canned-responses?search=greeting
POST /api/v1/canned-responses
PATCH /api/v1/canned-responses/:id
DELETE /api/v1/canned-responses/:id
```

---

# Notes Module — Technical Reference

**Path:** `src/notes/`

Standalone notes attached to CRM records (contacts, deals, accounts):

```typescript
Note {
  tenantId: ObjectId;
  content: string;
  relatedTo: {
    type: 'contact' | 'deal' | 'account';
    id: string;
  };
  authorId: ObjectId;
  attachments?: FileType[];
  createdAt: Date;
}
```

**API:**
```
GET  /api/v1/notes?relatedToType=contact&relatedToId=:id
POST /api/v1/notes
PATCH /api/v1/notes/:id
DELETE /api/v1/notes/:id
```
