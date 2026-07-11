# CRM Omnichannel — Đặc tả Hạ tầng, Networking & Security (Infrastructure Spec)

> Phiên bản: **2026-07-11** · Môi trường: **3 node, DigitalOcean SGP1**
> Hạ tầng đã được **chuyển hoàn toàn sang 3 droplet mới** (bản 2026-06-20 mô tả 5-node load-test env
> đã lỗi thời — xem [devops-loadtest-infra.md](devops-loadtest-infra.md) cho lịch sử load-test cũ).
> Node A giờ là **full-stack**: API + web + manager (api/web) + Keycloak, không chỉ API + edge như trước.

---

## Mục lục

1. [Node Inventory](#node-inventory)
2. [Kiến trúc Networking](#2-kiến-trúc-networking)
3. [Ma trận Port theo node](#3-ma-trận-port)
4. [Domain & SSL](#4-domain--ssl)
5. [Đặc tả từng Server](#5-đặc-tả-từng-server)
6. [CI/CD](#6-cicd)
7. [Keycloak (crm-auth)](#7-keycloak-crm-auth)
8. [MongoDB](#8-mongodb)
9. [Quản lý secret](#9-quản-lý-secret)
10. [Việc còn thiếu](#10-việc-còn-thiếu)

---

## Node Inventory

| Node | Hostname | Public IP | VPC IP (`eth1`) | Vai trò |
| ---- | -------- | --------- | ---------------- | ------- |
| A | crm-api | `68.183.232.123` | `10.104.0.2` | Full app stack: crm-api, crm-web, crm-manager-api, crm-manager-web, crm-auth (Keycloak), nginx edge |
| B | crm-db | `165.22.109.35` | `10.104.0.5` | MongoDB 8.0 (rs0, auth) + Redis 7 (native, không docker) |
| C | crm-bot | `139.59.237.103` | `10.104.0.3` | crm-bot (Typebot fork): builder/viewer/workflows + Postgres (Redis/S3 dùng chung Node B / DO Spaces) |

> Không còn Node monitoring/livechat riêng trong bản này — nếu cần Grafana/Prometheus hoặc
> crm-livechat, phải dựng lại trên droplet mới và bổ sung mục riêng vào doc này.

---

## 2. Kiến trúc Networking

```
                          INTERNET
        SSH admin, HTTPS người dùng, webhook Meta/Zalo
                              │
      ┌───────────────────────┼────────────────────────┐
      │ :22 SSH (cả 3 node)   │ :80/:443 (Node A, C)    │
      ▼                       ▼                          
 ┌─────────────────────── VPC 10.104.0.0/20 (SGP1) ───────────────────────┐
 │                                                                         │
 │  NODE A (10.104.0.2 / 68.183.232.123)                                  │
 │   nginx :80/:443 (TLS LE) ─┬─ crm-api          127.0.0.1:3000          │
 │                            ├─ crm-web           127.0.0.1:4200          │
 │                            ├─ crm-manager-api   127.0.0.1:3001 + VPC IP │
 │                            ├─ crm-manager-web   127.0.0.1:4201          │
 │                            └─ crm-auth/Keycloak 127.0.0.1:8080          │
 │        │ 27017/6379 (Mongo/Redis qua VPC)                              │
 │        ▼                                                                │
 │  NODE B (10.104.0.5 / 165.22.109.35) — native, không docker            │
 │   MongoDB rs0 bind 127.0.0.1,10.104.0.5:27017 (auth SCRAM + keyFile)   │
 │   Redis 7    bind 127.0.0.1,10.104.0.5:6379  (requirepass)             │
 │                                                                         │
 │  NODE C (10.104.0.3 / 139.59.237.103)                                  │
 │   nginx :80/:443 (TLS LE) ─┬─ builder  (10.104.0.3:4202) → bot.        │
 │                            └─ viewer   (10.104.0.3:4203) → chat.       │
 │   workflows (10.104.0.3:3002, internal RPC only, không public)         │
 │   Postgres (docker network riêng); Redis/S3 dùng chung Node B/Spaces  │
 └─────────────────────────────────────────────────────────────────────┘
```

### Nguyên tắc bind giữ nguyên từ bản cũ

- Không service backend nào bind `0.0.0.0` ra public — chỉ nginx (80/443, cả A và C).
- DB/Redis Node B chỉ bind `127.0.0.1` + VPC IP, UFW chỉ allow từ `10.104.0.0/20`.
- `crm-manager-api` là ngoại lệ: publish **cả** `127.0.0.1:3001` **và** `10.104.0.2:3001` vì
  `crm-manager-web`'s nginx (chạy trong container riêng) cần gọi sang qua VPC IP —
  container→host qua `host.docker.internal` **không** reach được port chỉ bind `127.0.0.1`
  (giới hạn kernel Linux). Xem §5.1.3.

---

## 3. Ma trận Port

### Node A (`10.104.0.2` / `68.183.232.123`)

| Port | Service | Bind | Phơi | Ghi chú |
| ---- | ------- | ---- | ---- | ------- |
| 22 | SSH | `0.0.0.0` | PUBLIC | key-only chưa bật (xem §10) |
| 80/443 | nginx | `0.0.0.0` | PUBLIC | 1 nginx phục vụ 5 domain (server_name khác nhau) |
| 3000 | crm-api (docker) | `127.0.0.1` | LOCAL | nginx upstream |
| 4200 | crm-web (docker) | `127.0.0.1` | LOCAL | nginx upstream |
| 3001 | crm-manager-api (docker) | `127.0.0.1` **+** `10.104.0.2` | LOCAL+VPC | VPC IP để crm-manager-web container gọi sang |
| 4201 | crm-manager-web (docker) | `127.0.0.1` | LOCAL | nginx upstream |
| 8080 | crm-auth/Keycloak (docker) | `127.0.0.1` | LOCAL | nginx upstream, TLS terminate ở nginx |

### Node B (`10.104.0.5` / `165.22.109.35`)

| Port | Service | Bind | Phơi |
| ---- | ------- | ---- | ---- |
| 22 | SSH | `0.0.0.0` | PUBLIC |
| 27017 | MongoDB rs0 | `127.0.0.1,10.104.0.5` | VPC |
| 6379 | Redis 7 | `127.0.0.1,10.104.0.5` | VPC |

UFW: chỉ allow `10.104.0.0/20` cho 27017/6379 — không có rule public nào ngoài SSH.

### Node C (`10.104.0.3` / `139.59.237.103`)

| Port | Service | Bind | Phơi |
| ---- | ------- | ---- | ---- |
| 22 | SSH | `0.0.0.0` | PUBLIC |
| 80/443 | nginx | `0.0.0.0` | PUBLIC |
| 4202 | builder (docker) | `10.104.0.3` | VPC (nginx trên cùng host proxy vào) |
| 4203 | viewer (docker) | `10.104.0.3` | VPC |
| 3002 | workflows (docker) | `10.104.0.3` | VPC — chỉ RPC nội bộ, không có domain public |

Postgres của crm-bot chạy trong docker network riêng (`crm_bot_net`), không publish port ra host.
Redis dùng chung Node B (`10.104.0.5:6379/2`); file storage dùng DigitalOcean Spaces thật
(không còn MinIO tự host) — cả hai không có container riêng trên Node C nữa.

---

## 4. Domain & SSL

Toàn bộ domain dùng Let's Encrypt qua `certbot --nginx`, auto-renew qua systemd timer.

| Domain | Node | Upstream | App |
| ------ | ---- | -------- | --- |
| `crmsaudi.dev` | A | `127.0.0.1:4200` | crm-web |
| `api.crmsaudi.dev` | A | `127.0.0.1:3000` | crm-api |
| `manager.crmsaudi.dev` | A | `127.0.0.1:4201` | crm-manager-web |
| `manager-api.crmsaudi.dev` | A | `127.0.0.1:3001` | crm-manager-api |
| `auth.crmsaudi.dev` | A | `127.0.0.1:8080` | crm-auth (Keycloak) |
| `bot.crmsaudi.dev` | C | `10.104.0.3:4202` | crm-bot builder |
| `chat.crmsaudi.dev` | C | `10.104.0.3:4203` | crm-bot viewer |

DNS A record cho tất cả domain trên đã trỏ đúng IP droplet mới (xác nhận bằng `dig`/`nslookup` trước khi chạy certbot).

---

## 5. Đặc tả từng Server

### 5.1 Node A — full app stack

**OS:** Ubuntu 24.04 LTS. User `deploy` (docker group, sudo NOPASSWD, SSH key riêng cho GitHub Actions — không dùng chung key giữa các repo).

Deploy path mỗi repo (git clone trực tiếp, `git pull --ff-only` khi CI chạy):

| Repo | Path | Docker Compose |
| ---- | ---- | --------------- |
| crm-api | `/var/www/crm-api` | `docker-compose.yml` |
| crm-web | `/var/www/crm-web` | `docker-compose.yml` |
| crm-manager-api | `/var/www/crm-manager-api` | `docker-compose.yml` |
| crm-manager-web | `/var/www/crm-manager-web` | `docker-compose.yml` |
| crm-auth | `/var/www/crm-auth` | `docker-compose.yml` |

`docker-compose.yml` = stack production trong **mọi** repo (2026-07-11: đã đổi tên đồng bộ, trước
đó mỗi repo dùng tên khác nhau — `docker-compose.prod.yml`, `docker-compose.production.yaml`...).
`.env.example` = template chuẩn duy nhất (commit); `.env.production` = secret thật (không commit).

Mỗi app có `.env.production` riêng, `chmod 600`, gitignored, **không** commit.

#### 5.1.1 crm-api
`REDIS_HOST=10.104.0.5` (Node B qua VPC, không còn `host.docker.internal` như bản cũ 1-node).
`DATABASE_URL` trỏ Mongo Node B. `CRM_BOT_URL=http://10.104.0.3:4203` (Node C qua VPC).

#### 5.1.2 crm-manager-api
`DATABASE_URL` cũng trỏ Mongo Node B (cùng cluster với crm-api, KHÔNG còn dùng Atlas trực tiếp —
xem §8). `INTERNAL_API_KEY` phải khớp với crm-api để auth service-to-service hoạt động.
`CRM_API_BASE_URL=http://10.104.0.2:3000/api/v1`.

#### 5.1.3 crm-manager-web — hairpin NAT gotcha
`nginx.conf` bên trong container proxy `/api/` sang crm-manager-api. Ban đầu dùng
`host.docker.internal:3001`, nhưng `crm-manager-api` chỉ publish `127.0.0.1:3001` → **không
reachable** từ container khác qua host-gateway (Linux chặn traffic loopback-bound từ ngoài host,
kể cả từ container qua gateway). Fix: `crm-manager-api` publish thêm `10.104.0.2:3001`,
`crm-manager-web`'s nginx.conf trỏ `http://10.104.0.2:3001/api/` thay vì `host.docker.internal`.

#### 5.1.4 crm-auth (Keycloak) — xem §7

### 5.2 Node B — Data tier (native, không docker)

Giống thiết kế cũ: MongoDB 8.0 (`authorization: enabled`, `keyFile`, `replSetName: rs0`, member
duy nhất `10.104.0.5:27017`), Redis 7 (`requirepass`, `protected-mode yes`,
`maxmemory-policy noeviction`). Không cài node_exporter/promtail trong bản này (không có
monitoring stack riêng — xem §10 nếu cần khôi phục).

**Gotcha khi tạo user Mongo lần đầu:** với `authorization: enabled` + `replication` cùng lúc,
"localhost exception" của MongoDB chỉ cho phép **một lần createUser** trước khi bị vô hiệu hoá
(kể cả khi dùng `directConnection=true`, exception coi như đã dùng ngay sau lệnh đầu). Cách xử lý
nếu cần tạo thêm user sau: tắt tạm `security.authorization` trong `mongod.conf`, restart, tạo user
qua `db.runCommand({createUser:...})`, bật lại `authorization`, restart lần nữa.

### 5.3 Node C — crm-bot

Docker compose (`docker-compose.yml`), publish port trên `10.104.0.3` (VPC IP node này —
đã đổi từ `10.104.0.4` của load-test env cũ). Chỉ Postgres chạy trong `crm_bot_net`, không public.
`.env.production` trên node (`chmod 600`, không commit).

**Redis:** dùng chung Node B (`10.104.0.5:6379`, DB index `/2` — crm-api đã dùng `/0` và `/1`),
không còn container Redis riêng trên Node C.

**File storage:** DigitalOcean Spaces thật (bucket `crmsaudidev`, region `sgp1`, endpoint
`sgp1.digitaloceanspaces.com`) — dùng chung credential với crm-api, không còn MinIO tự host.

---

## 6. CI/CD

6 repo dùng GitHub Actions, mỗi repo có SSH deploy key **riêng** (không dùng chung 1 key như bản
load-test cũ) — least-privilege, dễ revoke từng repo độc lập:

| Repo | Cơ chế | Trigger |
| ---- | ------ | ------- |
| crm-api | `git pull --ff-only` trên VPS + docker build | push `main` |
| crm-web | `git reset --hard` trên VPS + docker build | push `main` |
| crm-manager-api | `git pull` + docker build | push `main` |
| crm-manager-web | `git pull` + docker build | push `main` |
| crm-auth | `git pull` + validate placeholder secret + docker build (chỉ service `keycloak`) | push `main` |
| crm-bot | rsync từ GitHub runner → Node C (không phải git repo trên node) | push `main` |

GitHub Secrets mỗi repo: `VPS_HOST`, `VPS_USERNAME=deploy`, `VPS_SSH_PRIVATE_KEY`, `VPS_SSH_PORT=22`, `DEPLOY_PATH`.

---

## 7. Keycloak (crm-auth)

Dựng mới hoàn toàn trên Node A (`auth.crmsaudi.dev`), **không kế thừa** cấu hình/realm cũ.

- Realm: `crm-saas` (feature `organization` bật qua build flag `--features=organization`)
- Client: `crm-api`, `crm-api-admin`, `crm-manager-api`, `crm-bot` — mỗi client 1 secret riêng,
  `serviceAccountsEnabled=true`, `authorizationServicesEnabled=true`
- Postgres riêng cho Keycloak (`auth_db` container), không share với Mongo app data
- Admin: user `admin`, password trong `/var/www/crm-auth/.env.production` (`KEYCLOAK_ADMIN_PASSWORD`)
- Tạo client mới / đổi redirect URI: `docker exec auth_server /opt/keycloak/bin/kcadm.sh ...`
  (đăng nhập bằng `kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin`)

---

## 8. MongoDB

Production data đã **migrate từ MongoDB Atlas** (`crm.sfh1nlk.mongodb.net`) **sang MongoDB local
Node B** (2026-07-11): `mongodump` từ Atlas → `mongorestore` vào `10.104.0.5:27017`
(database `crm`: 229,063 documents bao gồm 220,093 contacts; `crm_audit_logs`: 11 documents).

Atlas cluster cũ **vẫn còn nguyên dữ liệu** (không xoá) — có thể giữ làm backup tạm thời rồi tự
quyết định pause/xoá sau khi xác nhận Node B ổn định qua một thời gian vận hành.

Connection string chuẩn (Node A → Node B qua VPC):
```
mongodb://crm:<PASSWORD>@10.104.0.5:27017/crm?replicaSet=rs0&authSource=crm
```

---

## 9. Quản lý secret

| Mục | Vị trí |
| --- | ------ |
| SSH deploy key (CI/CD) | Riêng biệt theo node, không chung 1 key — private key chỉ nằm trong GitHub Secrets, không lưu trên máy admin sau khi setup |
| Mongo/Redis password (Node B) | Trong `.env.production` mỗi app trên Node A, `chmod 600`, gitignored |
| Keycloak admin + DB password | `/var/www/crm-auth/.env.production` |
| App secret khác (JWT, encryption key, INTERNAL_API_KEY) | Tự sinh ngẫu nhiên lúc dựng hạ tầng, lưu trong `.env.production` từng node |
| Secret bên thứ ba (SendGrid, Facebook, SMTP...) | **Placeholder giả** — xem [`docs/SETUP_TODO.md`](../../docs/SETUP_TODO.md) |
| S3 (DigitalOcean Spaces) | Credential thật, dùng chung cho crm-api và crm-bot |

**Quy ước `.env` thống nhất (2026-07-11) cho cả 6 repo:** `.env` (dev, gitignore) /
`.env.production` (thật, gitignore, chỉ VPS + bản sao local tiện dùng) / `.env.example`
(template chuẩn duy nhất, commit). `.gitignore` mỗi repo dùng pattern `.env` + `.env.*` +
`!.env.example` — không liệt kê tên file riêng lẻ.

**Sự cố đã xử lý:**
- `crm-bot/.env.prod.example` từng chứa secret thật committed vào repo public
  (Postgres/Redis/S3/SMTP/Keycloak cũ) — đã thay bằng placeholder. Secret cũ vẫn cần rotate trên
  nhà cung cấp thật (xem SETUP_TODO.md §2).
- `crm-manager-web/.gitignore` có dòng `!.env.production` cố tình un-ignore — đã untrack (nội dung
  không nhạy cảm, nhưng sai pattern).
- `crm-bot/.env.dev` từng track kèm GitHub OAuth secret thật, và file này thực ra không được script
  hay Next.js nào đọc tới — đã xoá hẳn thay vì chỉ redact.

---

## 10. Việc còn thiếu

Xem đầy đủ tại [`docs/SETUP_TODO.md`](../../docs/SETUP_TODO.md). Tóm tắt:

- [ ] SendGrid API key cho crm-api (bắt buộc — app crash-loop nếu thiếu)
- [ ] SMTP thật cho crm-api và crm-bot
- [ ] Facebook/Google/Microsoft OAuth nếu dùng các kênh/tính năng tương ứng
- [ ] crm-bot chưa build/chạy container trên Node C (mới chỉ có `.env.prod`)
- [ ] SSH key-only + tắt password auth trên cả 3 node (hiện tại vẫn còn password auth)
- [ ] Không có monitoring/observability stack (Grafana/Prometheus) trong hạ tầng mới — cần dựng lại nếu cần
- [ ] Không có Node livechat riêng — nếu cần `livechat.crmsaudi.dev`, phải dựng droplet mới
