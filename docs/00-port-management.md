# Port & Service Management — Production Reference

> **Mục tiêu**: Tài liệu này là nguồn tham chiếu duy nhất (single source of truth) cho tất cả port,  
> network, IP tĩnh và cách quản lý các service CRM trên môi trường production.  
> Cập nhật tài liệu này mỗi khi thêm/thay đổi service hoặc port.

---

## Tổng quan kiến trúc mạng

```
Internet
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Nginx Reverse Proxy  (port 80 / 443 public)            │
│  TLS termination · Virtual host routing                  │
└────────────────────┬────────────────────────────────────┘
                     │ proxy_pass → 127.0.0.1:<port>
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
  :3000           :3001           :8080
crm-api      crm-manager-api   Keycloak (auth)
     │
     │ (internal)
  :6379                :8080/:8081
 Redis            Typebot (bot) — internal only
```

---

## Bảng Port Tổng hợp

| # | Service | Container | Host Port | Container Port | Bind | Network | IP Tĩnh |
|---|---------|-----------|-----------|----------------|------|---------|---------|
| 1 | **CRM API** | `crm-api` | `3000` | `3000` | `127.0.0.1` | `crm_api_net` | `172.25.0.10` |
| 2 | **CRM Worker** | `crm-api-worker` | _(none)_ | _(none)_ | — | `crm_api_net` | `172.25.0.11` |
| 3 | **CRM Omni Worker** | `crm-api-omni-worker` | _(none)_ | _(none)_ | — | `crm_api_net` | `172.25.0.12` |
| 4 | **CRM Email Worker** | `crm-api-email-worker` | _(none)_ | _(none)_ | — | `crm_api_net` | `172.25.0.13` |
| 5 | **CRM Manager API** | `crm-manager-api` | `3001` | `3001` | `127.0.0.1` | `crm_manager_api_net` | `172.27.0.10` |
| 6 | **Keycloak (Auth)** | `auth_server` | `8080` | `8080` | `0.0.0.0`* | `auth_network` | _(bridge)_ |
| 7 | **Keycloak DB** | `auth_db` | _(none)_ | `5432` | — | `auth_network` | _(internal)_ |
| 8 | **Redis** | `crm-redis` | `6379` | `6379` | `0.0.0.0`* | _(default)_ | _(bridge)_ |
| 9 | **Typebot Builder** | _(typebot)_ | `8080` | `3000` | `0.0.0.0` | `typebot-network` | _(bridge)_ |
| 10 | **Typebot Viewer** | _(typebot)_ | `8081` | `3000` | `0.0.0.0` | `typebot-network` | _(bridge)_ |
| 11 | **Typebot DB** | _(typebot)_ | _(none)_ | `5432` | — | `typebot-network` | _(internal)_ |

> **⚠ Lưu ý bảo mật**: Các service đánh dấu `0.0.0.0*` nên được đưa về `127.0.0.1` trên production  
> và để **Nginx** làm reverse proxy ra ngoài internet.

---

## Chi tiết từng Service

### 1. CRM API (`crm-api`) — Port 3000

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-api` |
| Docker Compose | `crm-api/docker-compose.yml` |
| Entrypoint | `src/main.ts` → `dist/main.js` |
| `APP_RUNTIME` | `api` |
| Port binding | `127.0.0.1:3000:3000` |
| Subnet | `172.25.0.0/16` |
| IP tĩnh | `172.25.0.10` |
| Env file | `.env.production` |
| Memory limit | `2g` |
| CPU limit | `${CRM_API_CPUS:-1.0}` |

**Công dụng**: HTTP REST API (prefix `/api/v1`), Socket.IO WebSocket gateway (`/omni`, `/omni-presence`), Swagger docs (`/docs`), BullMQ board (`/queues`).

**Healthcheck**:
```
wget -qO- http://127.0.0.1:3000/api/v1/health
interval: 30s | timeout: 5s | retries: 3 | start_period: 30s
```

**Script production**:
```bash
npm run start:api:prod
# → node -e "process.env.NODE_ENV='production'; require('./dist/main')"
```

---

### 2. CRM Worker (`crm-api-worker`) — No Port

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-api` (cùng image với API) |
| Docker Compose | `crm-api/docker-compose.yml` |
| Entrypoint | `src/worker.ts` → `dist/worker.js` |
| `APP_RUNTIME` | `worker` |
| Port binding | **Không có** (chỉ consume BullMQ queues) |
| Subnet | `172.25.0.0/16` |
| IP tĩnh | `172.25.0.11` |
| Memory limit | `2g` |
| CPU limit | `${CRM_WORKER_CPUS:-1.0}` |

**Công dụng**: Xử lý BullMQ queue processors hỗ trợ API: tenant provisioning, contact export/scoring, SLA breach, escalation, automation (action, email, SMS, internal, webhook, DLQ, bulk, delayed), social-post publishing.

> **Lưu ý**: Worker chính KHÔNG xử lý omni processors và email processors — những processors này đã tách sang omni-worker và email-worker.

**Script production**:
```bash
npm run start:worker:prod
# → node -e "process.env.NODE_ENV='production'; require('./dist/worker')"
```

---

### 3. CRM Omni Worker (`crm-api-omni-worker`) — No Port

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-api` (cùng image với API) |
| Docker Compose | `crm-api/docker-compose.yml` |
| Entrypoint | `src/omni-worker.ts` → `dist/omni-worker.js` |
| `APP_RUNTIME` | `omni` |
| Port binding | **Không có** (pure worker, publish events qua Redis pub/sub) |
| Subnet | `172.25.0.0/16` |
| IP tĩnh | `172.25.0.12` |
| Memory limit | `3g` |
| CPU limit | `${CRM_OMNI_CPUS:-2.0}` |

**Công dụng**: Worker chuyên biệt cho omni-channel — xử lý 6 BullMQ processors: webhook, routing, media cache, sticky retry, auto-resolve, bot processing. **Không có Socket.IO** — publish events qua Redis pub/sub để api-service broadcast lên frontend.

**Luồng event**:
```
omni-worker → Redis PUBLISH → api-service (OmniGateway) SUBSCRIBE → socket.emit → Frontend
```

**Script production**:
```bash
npm run start:omni-worker:prod
# → node -e "process.env.NODE_ENV='production'; require('./dist/omni-worker')"
```

---

### 4. CRM Email Worker (`crm-api-email-worker`) — No Port

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-api` (cùng image với API) |
| Docker Compose | `crm-api/docker-compose.yml` |
| Entrypoint | `src/email-worker.ts` → `dist/email-worker.js` |
| `APP_RUNTIME` | `email-worker` |
| Port binding | **Không có** (pure worker) |
| Subnet | `172.25.0.0/16` |
| IP tĩnh | `172.25.0.13` |
| Memory limit | `1g` |
| CPU limit | `${CRM_EMAIL_WORKER_CPUS:-0.5}` |

**Công dụng**: Worker chuyên biệt cho email — xử lý IMAP polling, mail queue (welcome emails), read-state sync (IMAP \Seen flag), channel health check.

**Script production**:
```bash
npm run start:email-worker:prod
# → node -e "process.env.NODE_ENV='production'; require('./dist/email-worker')"
```

---

### 5. CRM Manager API (`crm-manager-api`) — Port 3001

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-manager-api` |
| Docker Compose | `crm-manager-api/docker-compose.yml` |
| Entrypoint | `src/main.ts` |
| Port binding | `127.0.0.1:3001:3001` |
| Subnet | `172.27.0.0/16` |
| IP tĩnh | `172.27.0.10` |
| Env file | `.env.production` |

**Công dụng**: Admin/Manager API — quản lý tenants, users, permission groups, onboarding, system settings. Dùng riêng cho `manager.crmsaudi.dev`.

**Script production**:
```bash
npm run start:prod
```

---

### 5. Keycloak Auth Server (`auth_server`) — Port 8080

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-auth` |
| Docker Compose | `crm-auth/docker-compose.production.yaml` |
| Image | `crm-auth-keycloak:latest` (custom build) |
| Port binding | `${KEYCLOAK_HTTP_PORT:-8080}:8080` |
| Network | `auth_network` (bridge) |
| Env file | `.env.production` |
| Public URL | `https://auth.crmsaudi.dev` |

**Công dụng**: Identity Provider (SSO) cho toàn bộ hệ thống CRM. Quản lý realm `crm-saas`, issue JWT token cho tất cả clients.

**Keycloak clients được đăng ký**:
| Client ID | Service sử dụng |
|---|---|
| `crm-api` | CRM API (verify tokens) |
| `crm-api-admin` | CRM API (admin operations) |
| `crm-manager-api` | Manager API |

**Database**: PostgreSQL (`auth_db`) — chỉ internal, không expose port.

---

### 6. Redis (`crm-redis`) — Port 6379

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-redis` |
| Docker Compose | `crm-redis/docker-compose.yaml` |
| Image | `redis:7-alpine` |
| Port binding | `6379:6379` ⚠ (cần đổi về `127.0.0.1:6379:6379`) |
| Persistence | AOF (`appendonly yes`) |
| Eviction policy | `noeviction` (required by BullMQ) |

**Database phân tách**:
| DB Index | Mục đích |
|---|---|
| `0` | Cache (`REDIS_CACHE_DB=0`) |
| `1` | BullMQ Queue (`REDIS_QUEUE_DB=1`) |

**Kết nối từ API/Worker** (trong Docker dùng `host.docker.internal`):
```env
REDIS_HOST=host.docker.internal
REDIS_PORT=6379
WORKER_HOST=redis://host.docker.internal:6379/1
```

---

### 7. Typebot Bot Builder — Port 8080

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-bot` |
| Docker Compose | `crm-bot/docker-compose.yml` |
| Image | `baptistearno/typebot-builder:latest` |
| Port binding | `8080:3000` |
| Network | `typebot-network` |

**Công dụng**: UI editor để tạo và quản lý bot flows.

---

### 8. Typebot Bot Viewer — Port 8081

| Thuộc tính | Giá trị |
|---|---|
| Repo | `e:/CRM/crm-bot` |
| Docker Compose | `crm-bot/docker-compose.yml` |
| Image | `baptistearno/typebot-viewer:latest` |
| Port binding | `8081:3000` |
| Network | `typebot-network` |

**Công dụng**: Runtime engine chạy bot flows cho end-user.

---

## Docker Networks

| Network | Subnet | Gateway | Service dùng |
|---|---|---|---|
| `crm_api_net` | `172.25.0.0/16` | `172.25.0.1` | crm-api, crm-api-worker, crm-api-omni |
| `crm_manager_api_net` | `172.27.0.0/16` | `172.27.0.1` | crm-manager-api |
| `auth_network` | _(bridge)_ | _(auto)_ | auth_server, auth_db |
| `typebot-network` | _(bridge)_ | _(auto)_ | typebot-builder, typebot-viewer, typebot-db |

> **Convention**: Mỗi nhóm service độc lập dùng một Docker network riêng. Không cross-mount network giữa các nhóm — giao tiếp qua `host.docker.internal` hoặc hostname của container.

---

## Nginx Reverse Proxy Config (Reference)

```nginx
# CRM Main API + WebSocket
server {
    server_name api.crmsaudi.dev;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# CRM Manager API
server {
    server_name manager-api.crmsaudi.dev;
    location / {
        proxy_pass http://127.0.0.1:3001;
    }
}

# Keycloak Auth
server {
    server_name auth.crmsaudi.dev;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Omni Service (WebSocket — khi tách riêng)
server {
    server_name omni.crmsaudi.dev; # hoặc upstream từ api.crmsaudi.dev
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## Môi trường Dev (Local)

| Service | Port | Ghi chú |
|---|---|---|
| crm-api | `3000` | `npm run start:dev` |
| crm-api worker | _(none)_ | `npm run start:worker:dev` |
| crm-manager-api | `3001` | `npm run start:dev` |
| crm-manager-web | `5173` | Vite dev server |
| crm-web | `5174` | Vite dev server |
| Typebot Builder | `4202` | `NEXTAUTH_URL` |
| Typebot Viewer | `4203` | `NEXT_PUBLIC_VIEWER_URL` |
| Typebot Workflows | `3002` | `WORKFLOWS_SERVER_PORT` |
| MinIO (S3 dev) | `9000` | S3 API |
| MinIO Console | `9001` | Admin UI |
| Redis | `6379` | Local |
| PostgreSQL (Typebot) | `5432` | Local |
| Grafana (OTEL) | `3010` | `grafana/otel-lgtm` |
| OTEL gRPC | `4317` | OpenTelemetry |
| OTEL HTTP | `4318` | OpenTelemetry |

---

## Checklist Deploy Production

```bash
# 1. Khởi động Redis trước (dependency của tất cả services)
cd crm-redis && docker compose up -d

# 2. Khởi động Auth (Keycloak)
cd crm-auth && docker compose -f docker-compose.production.yaml up -d

# 3. Khởi động CRM API stack
cd crm-api && docker compose up -d

# 4. Khởi động Manager API
cd crm-manager-api && docker compose up -d

# 5. Khởi động Bot (optional)
cd crm-bot && docker compose up -d

# Kiểm tra health
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:8080/health/ready
```

---

## Ports Reserved — Tránh conflict

| Port | Đã dùng bởi | Được phép dùng thêm? |
|---|---|---|
| `3000` | crm-api | ❌ |
| `3001` | crm-manager-api | ❌ |
| `6379` | Redis | ❌ |
| `8080` | Keycloak / Typebot Builder | ⚠ Conflict! Xem ghi chú bên dưới |
| `8081` | Typebot Viewer | ❌ |
| `5173` | crm-web (dev) | Dev only |
| `5174` | crm-manager-web (dev) | Dev only |
| `27017` | MongoDB Atlas (remote) | Remote only |

> **⚠ Port 8080 conflict**: Cả Keycloak và Typebot Builder đều dùng port `8080`.  
> Chúng được chạy trên **các máy hoặc namespace khác nhau** — không chạy đồng thời trên cùng host.  
> Nếu cần chạy cùng host: đổi Typebot Builder sang port `8082`.

---

*Cập nhật lần cuối: 2026-05-24 — bởi AI assistant*  
*Tài liệu liên quan: [`docker-compose.yml`](../docker-compose.yml) · [`crm-manager-api/docker-compose.yml`](../../crm-manager-api/docker-compose.yml) · [`crm-auth/docker-compose.production.yaml`](../../crm-auth/docker-compose.production.yaml)*
