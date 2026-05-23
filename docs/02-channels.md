# Channels Module — Technical Reference

**Path:** `src/channels/`  
**Module class:** `ChannelsModule`

```
channels/
├── channels.controller.ts
├── channels.service.ts         # 800+ lines — main orchestrator
├── channels.module.ts
├── domain/
│   └── channel.ts              # Domain entity
├── infrastructure/persistence/document/
│   ├── entities/channel.schema.ts
│   └── repositories/channel.repository.ts
├── adapters/
│   └── meta.adapter.ts         # Facebook/Instagram Graph API wrapper
├── mail-inbound/               # IMAP inbound email processing
├── channel-alert/              # Alert service for offline channels
├── channel-health/             # Scheduled health checks
└── channel-settings/           # Per-channel config CRUD
```

---

## 1. Channel Domain Model

```typescript
// MongoDB collection: channels
Channel {
  id: string;                    // ObjectId
  tenantId: string;              // Immutable — owner tenant
  type: ChannelType;             // 'facebook' | 'instagram' | 'whatsapp' | 'email'
  name: string;                  // Display name
  account: string;               // Page ID / phone / email address (globally unique)
  status: ChannelStatus;         // 'Pending' | 'Connected' | 'Disconnected' | 'Error'
  
  credentials: {
    accessToken?: string;        // Long-lived Meta token (stored encrypted)
    refreshToken?: string;
    tokenExpiresAt?: Date;
  };
  
  config: {
    businessHoursEnabled: boolean;
    autoReplyEnabled: boolean;
    autoReplyMessage: string;
    defaultRoutingRuleId?: string;
    webhookStatus?: string;
    avatarUrl?: string;
  };
  
  externalId?: string;           // Meta Page ID or WABA ID
  createdAt: Date;
  updatedAt: Date;
}
```

**MongoDB indexes:**
- `{ tenantId: 1, status: 1 }`
- `{ account: 1 }` — unique globally

---

## 2. Meta OAuth Flow (Facebook / Instagram)

### 2.1 Step 1 — Build Auth URL

```
GET /api/v1/channels/meta/auth-url?type=facebook&openerOrigin=https://acme.crmsaudi.dev
```

`ChannelsService.buildMetaAuthUrl(type, openerOrigin)`:
1. Validate `openerOrigin` against allowed domains (`APP_ROOT_DOMAIN`)
2. Generate CSRF state: `ulid()`
3. Store in Redis: `SET meta:oauth:state:<state> <openerOrigin>` TTL=10min
4. Build Meta OAuth URL:
   - `https://www.facebook.com/dialog/oauth?client_id=...&redirect_uri=...&state=...&scope=...`
   - **Facebook scopes:** `pages_show_list,pages_manage_metadata,pages_read_engagement,pages_messaging,instagram_basic,instagram_manage_messages`
   - **WhatsApp extra scope:** `whatsapp_business_management,whatsapp_business_messaging`
5. Return `{ url }`

### 2.2 Step 2 — OAuth Callback

```
GET /api/v1/channels/meta/callback?code=...&state=...
```

`ChannelsService.handleMetaCallback(params)`:
1. `GET meta:oauth:state:<state>` from Redis — validates CSRF
2. `DEL meta:oauth:state:<state>` (one-time use)
3. **Exchange short-lived code:**
   ```
   POST https://graph.facebook.com/oauth/access_token
     { client_id, client_secret, redirect_uri, code }
   → short_lived_token (1h)
   ```
4. **Exchange for long-lived token:**
   ```
   GET https://graph.facebook.com/oauth/access_token
     { grant_type=fb_exchange_token, client_id, client_secret, fb_exchange_token=short_lived }
   → long_lived_token (60 days)
   ```
5. **Fetch available pages/accounts:**
   - Facebook: `GET /me/accounts?fields=id,name,picture,access_token`
   - Instagram: `GET /{page-id}?fields=instagram_business_account{id,name,picture}` per page
   - WhatsApp: `GET /me/businesses/{id}/phone_numbers`
6. Store OAuth result in Redis: `SET meta:oauth:result:<resultId>` TTL=10min
7. Return HTML `postMessage` to opener: `{ type: 'META_OAUTH_RESULT', resultId }`

### 2.3 Step 3 — Get OAuth Result

```
GET /api/v1/channels/meta/oauth-result/:resultId
```

Returns list of available pages/accounts **without** access tokens.

### 2.4 Step 4 — Connect Channels

```
POST /api/v1/channels/meta/connect
{ resultId, selectedPageIds: ['123', '456'] }
```

`ChannelsService.connectMetaChannels(dto)`:
1. Fetch OAuth result from Redis
2. For each selected page:
   - Validate `account` not already claimed by another tenant (`{ account: pageId }`)
   - Subscribe Meta webhooks: `POST /{page-id}/subscribed_apps`
   - Create/update `Channel` record with status=`Connected`
3. Return created channel objects

---

## 3. Channel Lifecycle

```
Pending ──► Connected ──► Error
               │               ▲
               └─► Disconnected ┘ (reconnect → Connected)
```

| Transition | Trigger |
|---|---|
| `Pending → Connected` | `connectMetaChannels()` or `create()` with valid token |
| `Connected → Disconnected` | `disconnect()` called by user, or webhook unsubscribe |
| `Connected → Error` | Publisher receives 401 from Meta (token expired) |
| `Disconnected → Connected` | User reconnects via OAuth flow |

---

## 4. Key Service Methods

### `ChannelsService`

| Method | Description |
|---|---|
| `buildMetaAuthUrl(type, openerOrigin)` | Build Meta OAuth URL with CSRF state |
| `handleMetaCallback(params)` | Full OAuth callback processing |
| `getMetaOAuthResult(resultId)` | Fetch pending OAuth result from Redis |
| `connectMetaChannels(dto)` | Connect selected pages, subscribe webhooks |
| `create(dto)` | Manually create channel (email channels, etc.) |
| `findAll(tenantId, filters)` | List channels for tenant |
| `findById(tenantId, id)` | Single channel lookup |
| `update(tenantId, id, dto)` | Update channel metadata or config |
| `disconnect(tenantId, id)` | Unsubscribe webhooks + set Disconnected |
| `delete(tenantId, id)` | Disconnect + hard delete |
| `findByIdWithCredentials(tenantId, id)` | Returns channel WITH access token (internal use only) |

### `ChannelRepository`

| Method | Description |
|---|---|
| `findByIdWithCredentials(tenantId, id)` | Bypasses field exclusion — only for publisher |
| `findByAccount(account)` | Global lookup for dedup (cross-tenant) |
| `findConnectedByTenant(tenantId)` | All `Connected` channels |
| `updateStatus(tenantId, id, status)` | Atomic status update |

---

## 5. Email Channel (`mail-inbound/`)

IMAP polling-based inbound email:
- `MailInboundService.pollAllMailboxes()` — cron job every 30s
- Uses `imapflow` for IMAP connections with per-channel state tracking
- Parsed emails are routed via `OmniInboundService`
- `TransportPoolService` manages SMTP connections for outbound

---

## 6. Channel Health & Alerts

**`ChannelHealthCheckService`** — cron every 15 minutes:
- Calls `GET /{page-id}?fields=id` for each Connected Meta channel
- If error: marks channel `Error`, emits `channel.health_check_failed` event

**`ChannelAlertService`** — listens to `channel.health_check_failed`:
- Creates a notification for the tenant owner
- Sends email alert via mail queue

---

## 7. Meta Webhook Subscription

When a channel is connected, the system subscribes Meta webhooks:
```
POST https://graph.facebook.com/{page-id}/subscribed_apps
  { access_token, subscribed_fields: 'messages,messaging_postbacks,feed' }
```

Inbound webhooks hit `POST /api/v1/webhooks/meta` (handled by `OmniInboundModule`).

---

## 8. API Endpoints

### Channels CRUD
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/channels` | `settings:view` | List tenant channels |
| `POST` | `/api/v1/channels` | `settings:manage_system` | Create channel |
| `GET` | `/api/v1/channels/:id` | `settings:view` | Get channel |
| `PATCH` | `/api/v1/channels/:id` | `settings:manage_system` | Update |
| `DELETE` | `/api/v1/channels/:id` | `settings:manage_system` | Delete |
| `POST` | `/api/v1/channels/:id/disconnect` | `settings:manage_system` | Disconnect |

### Meta OAuth
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/channels/meta/auth-url` | Session | Get OAuth URL |
| `GET` | `/api/v1/channels/meta/callback` | Public | OAuth callback (server-side) |
| `GET` | `/api/v1/channels/meta/oauth-result/:resultId` | Session | Available pages |
| `POST` | `/api/v1/channels/meta/connect` | Session | Connect selected channels |

### Channel Config
| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/v1/channels/:id/config` | `settings:view` | Get channel config |
| `PUT` | `/api/v1/channels/:id/config` | `settings:manage_system` | Update config |

---

## 9. Security Notes

- Access tokens are **never returned** to the frontend — `findByIdWithCredentials` is internal only
- `openerOrigin` is validated against `*.{APP_ROOT_DOMAIN}` before use in `postMessage`
- Channel `account` field is globally unique — prevents cross-tenant account hijacking
- Meta webhook verification uses `X-Hub-Signature-256` HMAC with `FACEBOOK_APP_SECRET`

---

## 10. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FACEBOOK_APP_ID` | ✅ | Meta App ID |
| `FACEBOOK_APP_SECRET` | ✅ | Meta App Secret (webhook verification + token exchange) |
| `FACEBOOK_WHATSAPP_CONFIG_ID` | ⚠️ | Required for WhatsApp channels |
| `BACKEND_DOMAIN` | ✅ | Used to build the OAuth callback URL |
| `APP_ROOT_DOMAIN` | ✅ | Validates `openerOrigin` |
