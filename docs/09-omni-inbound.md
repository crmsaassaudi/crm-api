# Omni-Channel Inbox — Technical Reference

**Path:** `src/omni-inbound/`, `src/omni-outbound/`  
**Module classes:** `OmniInboundModule`, `OmniOutboundModule`

---

## 1. Architecture Overview

The omni-channel inbox has **12 pillars** per the module definition:

```
Pillar 1: Data Normalization     — Platform adapters + InboundProcessorService
Pillar 2: Agent System           — AgentPresenceService, ConversationLockService
Pillar 3: Realtime UX            — OmniGateway (Socket.IO)
Pillar 4: Webhook Queue          — BullMQ: WebhookProcessor, OmniRoutingProcessor, etc.
Pillar 5: Persistence            — ConversationService, ConversationRepository, MessageRepository
Pillar 6: REST API               — OmniController (frontend endpoints)
Pillar 7: Notes                  — NoteService, NoteRepository
Pillar 8: Assignment Engine      — AssignmentService (round-robin, least-busy, sticky)
Pillar 9: Audit Trail            — ActivityService, ActivityRepository
Pillar 10: Agent Fallback        — AgentFallbackService
Pillar 11: Session Lifecycle     — AutoResolveService, BusinessHoursService
Pillar 12: Agent Status Audit    — AgentStatusAuditService (Work Time KPI)
```

---

## 2. Supported Platforms

| Platform | Adapter | Webhook |
|---|---|---|
| Facebook Messenger | `FacebookAdapter` | `POST /api/v1/webhooks/facebook` |
| WhatsApp Business | `WhatsAppAdapter` | `POST /api/v1/webhooks/whatsapp` |
| Zalo | `ZaloAdapter` | `POST /api/v1/webhooks/zalo` |
| Email (IMAP) | (in ChannelsModule) | — polling, not webhook |

---

## 3. Webhook Ingest Flow

```
Platform webhook
  │
  ▼
POST /api/v1/inbound/{platform}
  │
InboundController.receive()
  │
  ▼ (immediate 200 OK to platform — must respond < 5s)
OmniQueueModule: queue.add('webhook', rawPayload)
  │
  ▼ (async, BullMQ worker)
WebhookProcessor.process()
  │
InboundProcessorService.process(rawPayload)
  │
  ├─ ChannelAdapter.normalize(rawPayload) → OmniPayload
  │    (FacebookAdapter / WhatsAppAdapter / ZaloAdapter)
  │
  ├─ IdentityService.resolveContact(senderId, channelType)
  │    → find contact by omniIdentity.senderId
  │    → create shadow contact if not found
  │
  ├─ ConversationService.findOrCreate(tenantId, channelId, senderId)
  │    → find open conversation for this sender+channel
  │    → create new conversation if none open
  │
  ├─ MessageRepository.create(message)
  │    → store normalized message
  │
  ├─ AssignmentService.autoAssign(conversation)
  │    → apply routing rules → assign to agent/group
  │
  └─ OmniGateway.emit('new_message', payload)
       → push to connected agent browsers via Socket.IO
```

---

## 4. Data Models

### `OmniConversation` (collection: `omni_conversations`)

```typescript
{
  tenantId: ObjectId;
  channelId: ObjectId;
  channelType: string;
  contactId?: ObjectId;
  senderId: string;                // Platform sender ID
  status: 'open' | 'resolved' | 'pending';
  assignedAgentId?: ObjectId;
  assignedGroupId?: ObjectId;
  isSticky: boolean;               // Agent stickiness
  lastMessageAt: Date;
  autoResolveAt?: Date;            // Scheduled auto-resolve time
  businessHoursQueue: boolean;     // Waiting for business hours
  botActive: boolean;              // Bot handling this conversation
  createdAt, updatedAt: Date;
}

// Indexes:
{ tenantId, channelId, senderId, status }   — unique open conversation per sender
{ tenantId, assignedAgentId, status }
{ tenantId, status, lastMessageAt }
```

### `OmniMessage` (collection: `omni_messages`)

```typescript
{
  tenantId: ObjectId;
  conversationId: ObjectId;
  type: 'incoming' | 'outgoing' | 'activity';
  contentType: 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker';
  content: string;
  mediaUrl?: string;               // Proxied via MediaProxyService
  senderId?: string;               // Platform sender (incoming)
  agentId?: ObjectId;              // Agent who sent (outgoing)
  platformMessageId?: string;      // Original platform message ID
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
}

// Indexes:
{ tenantId, conversationId, createdAt: -1 }
{ tenantId, conversationId, isRead }
```

### `OmniNote` (collection: `omni_notes`)

Internal agent notes (not visible to customer):
```typescript
{
  tenantId: ObjectId;
  conversationId: ObjectId;
  content: string;
  authorId: ObjectId;
  createdAt: Date;
}
```

---

## 5. Assignment Engine (`AssignmentService`)

Three strategies, evaluated in order:

```
1. STICKY: if conversation.isSticky && assignedAgent is online
   → reassign to same agent

2. ROUTING RULES: evaluate routing rules for this conversation
   → rules: { conditions[], action: { assignTo: 'agent'|'group', targetId } }
   → first matching rule wins

3. AUTO-ASSIGN: if channel.config.autoAssign === true
   Strategy options (per channel config):
   a. 'round_robin'  — rotate through agents in group
   b. 'least_busy'   — agent with fewest open conversations
   c. 'random'       — random available agent
```

**Agent availability:** Checked via `AgentPresenceService.isOnline(agentId)`.

---

## 6. Agent Presence System

**`AgentPresenceService`** tracks agent online/offline state via Socket.IO + Redis:

```typescript
// Redis key: agent:presence:{tenantId}:{agentId}
// Value: JSON { status: 'online'|'away'|'offline', socketId, lastSeen }
// TTL: 30s — refreshed by heartbeat every 15s from client

setPresence(tenantId, agentId, status)
getPresence(tenantId, agentId): AgentPresence | null
getOnlineAgents(tenantId): AgentPresence[]
```

**`AgentPresenceGateway`** (Socket.IO):
- Event `agent:heartbeat` → refreshes Redis TTL
- Event `agent:status_change` → update presence + emit to team
- Disconnect handler → set presence to 'offline'

---

## 7. Realtime Gateway (`OmniGateway`)

Socket.IO namespace: `/omni`

Authentication: `HybridAuthGuard` on connection — validates `sid` cookie.

**Client events (server → client):**
| Event | Payload | Description |
|---|---|---|
| `new_message` | `{ conversationId, message }` | New inbound or outbound message |
| `conversation_assigned` | `{ conversationId, agentId }` | Assignment changed |
| `conversation_resolved` | `{ conversationId }` | Conversation closed |
| `typing_indicator` | `{ conversationId, agentId, isTyping }` | Agent typing |

**Server events (client → server):**
| Event | Description |
|---|---|
| `join_conversation` | Subscribe to updates for a conversation |
| `leave_conversation` | Unsubscribe |
| `typing_start` / `typing_stop` | Broadcast typing indicator |

---

## 8. Media Proxy (`MediaProxyService`)

Platforms (Facebook, WhatsApp) expire media URLs. The proxy caches them:

```
Client requests media:
GET /api/v1/media-proxy?url={encodedPlatformUrl}&channelId={id}

MediaProxyService:
  1. Check Redis cache: media:proxy:{hash(url)} → cached URL
  2. If miss: download from platform (with channel access token)
              store in local files/media/{hash}
              cache URL in Redis TTL=24h
  3. Return local URL

BullMQ: MediaCacheProcessor pre-fetches media for incoming messages
```

---

## 9. Bot Integration (`bot/`)

When `conversation.botActive === true`, messages are routed to the bot:

```
BotQueueService.enqueue(conversationId, message)
  → BullMQ queue: 'bot-processing'

BotProcessingProcessor.process():
  1. Lock conversation: BotConversationLockService (Redis SETNX)
  2. POST to BotApiService (crm-bot Typebot API)
  3. BotApiService sends back response messages
  4. OmniOutboundModule sends response to customer
  5. Release lock
```

**Handoff trigger:** When bot sends `{action: 'handoff'}` → `botActive = false`, conversation enters normal assignment flow.

---

## 10. Auto-Resolve (`AutoResolveService`)

Conversations can be auto-resolved after inactivity:

```typescript
scheduleAutoResolve(conversationId, delayMs):
  BullMQ delayed job: 'auto-resolve'
  delay = delayMs (from channel.config.autoResolveAfterMs)

AutoResolveProcessor.process():
  1. Check if conversation still open
  2. Check if last message > threshold
  3. Resolve conversation: status = 'resolved'
  4. Emit 'conversation_resolved' to agents
```

---

## 11. Business Hours (`BusinessHoursService`)

```typescript
isWithinBusinessHours(tenantId, channelId): boolean
  → Load channel.config.businessHours
  → Check current UTC time against schedule
  → Returns true/false

// If outside business hours:
// - Conversation flagged: businessHoursQueue = true
// - AutoReply sent (if configured)
// - Assignment deferred until business hours resume
```

---

## 12. Outbound (`OmniOutboundModule`)

**Path:** `src/omni-outbound/`

Sends messages from agents to customers through the appropriate platform:

```typescript
OmniOutboundService.send(conversationId, payload):
  1. Load conversation → channel
  2. channelRepository.findByIdWithCredentials → access token
  3. Platform adapter.send(payload, channel)

Facebook: POST https://graph.facebook.com/me/messages
  { recipient: { id: senderId }, message: { text | attachment } }

WhatsApp: POST https://graph.facebook.com/{phoneNumberId}/messages
  { to: phone, type: 'text', text: { body } }
```

---

## 13. Agent Status Audit (`AgentStatusAuditService`)

Tracks agent working time for KPI reports:

```typescript
// Collection: agent_status_audit_logs
AgentStatusAuditLog {
  tenantId: ObjectId;
  agentId: ObjectId;
  status: 'online' | 'away' | 'offline';
  startedAt: Date;
  endedAt?: Date;
  durationSeconds?: number;
}

// Endpoints:
GET /api/v1/agent-status-audit?agentId=&from=&to=
→ Work time summary per agent
```

---

## 14. REST API Endpoints

### Conversations
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/omni/conversations` | List conversations (filter by status, agent, channel) |
| `GET` | `/api/v1/omni/conversations/:id` | Get conversation with messages |
| `PATCH` | `/api/v1/omni/conversations/:id` | Update (assign, resolve, etc.) |
| `POST` | `/api/v1/omni/conversations/:id/messages` | Send outbound message |
| `GET` | `/api/v1/omni/conversations/:id/messages` | Message history (cursor paginated) |
| `POST` | `/api/v1/omni/conversations/:id/notes` | Add internal note |
| `GET` | `/api/v1/omni/conversations/:id/notes` | List notes |
| `POST` | `/api/v1/omni/conversations/:id/resolve` | Resolve conversation |
| `POST` | `/api/v1/omni/conversations/:id/assign` | Assign to agent/group |
| `POST` | `/api/v1/omni/conversations/:id/handoff-from-bot` | Transfer from bot to agent |

### Webhooks (Platform → API)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/inbound/facebook` | Facebook webhook verification |
| `POST` | `/api/v1/inbound/facebook` | Facebook webhook events |
| `GET` | `/api/v1/inbound/whatsapp` | WhatsApp webhook verification |
| `POST` | `/api/v1/inbound/whatsapp` | WhatsApp webhook events |

### Media Proxy
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/media-proxy` | Proxy + cache platform media |
