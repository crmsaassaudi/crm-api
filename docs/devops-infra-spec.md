# CRM Omnichannel — Đặc tả Hạ tầng, Networking & Security (Infrastructure Spec)

> Phiên bản: **2026-06-20** · Môi trường: **5 node, DigitalOcean SGP1**
> Tài liệu này là **bản đặc tả (specification)** — mô tả *trạng thái mong muốn* của hạ tầng: kiến trúc mạng, ma trận port, rule firewall, và cách dựng từng server.
> Phần *thao tác từng bước theo dòng thời gian* nằm ở runbook: [devops-loadtest-infra.md](devops-loadtest-infra.md). Hai tài liệu bổ sung cho nhau:
> - **Runbook** = "đã làm gì, theo thứ tự nào, sự cố gì".
> - **Spec (file này)** = "hệ thống *phải* trông như thế nào, vì sao, và kiểm chứng ra sao".

---

## Mục lục

1. [Nguyên tắc thiết kế (Design Principles)](#1-nguyên-tắc-thiết-kế)
2. [Kiến trúc Networking toàn hệ thống](#2-kiến-trúc-networking-toàn-hệ-thống)
3. [Ma trận Port (Port Inventory) — toàn bộ port theo node](#3-ma-trận-port-port-inventory)
4. [Bind-address & Docker port publishing](#4-bind-address--docker-port-publishing)
5. [Firewall (UFW) — đặc tả rule từng node](#5-firewall-ufw--đặc-tả-rule-từng-node)
6. [Mô hình Security phòng thủ nhiều lớp](#6-mô-hình-security-phòng-thủ-nhiều-lớp)
7. [Đặc tả setup từng Server](#7-đặc-tả-setup-từng-server)
8. [Luồng dữ liệu (Data Flows) chi tiết](#8-luồng-dữ-liệu-data-flows)
9. [Checklist audit hạ tầng](#9-checklist-audit-hạ-tầng)

## Node Inventory (Tổng hợp)

| Node | Hostname       | Public IP        | VPC IP        | Vai trò                        |
| ---- | -------------- | ---------------- | ------------- | ------------------------------ |
| A    | crm-service    | `167.172.77.62`  | `10.104.0.2`  | API + Workers + Edge nginx     |
| B    | crm-db         | `165.232.173.192`| `10.104.0.3`  | MongoDB RS0 + Redis            |
| C    | crm-monitoring | `168.144.128.121`| `10.104.0.4`  | Monitoring + Observability     |
| D    | crm-bot        | `159.89.199.112` | `10.104.0.5`  | Bot server (Typebot / n8n)     |
| E    | crm-livechat   | `168.144.130.45` | *(standalone)*| Livechat widget CDN + WS       |

---

## 1. Nguyên tắc thiết kế

| #   | Nguyên tắc                       | Hệ quả thực thi                                                                                                                                                               |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Private-by-default**           | DB, Redis, exporters, Loki chỉ bind VPC IP (`10.104.0.x`) hoặc `127.0.0.1`. Không service backend nào bind `0.0.0.0` ra public.                                               |
| P2  | **Tách load-generator khỏi SUT** | Node C (k6/simulator) **không bao giờ** chạy chung máy với Node A (app cần đo).                                                                                               |
| P3  | **Phòng thủ nhiều lớp**          | Mỗi cổng được bảo vệ bởi ≥2 lớp: (a) bind-address, (b) UFW, (c) auth ở tầng ứng dụng (Mongo auth, Redis requirepass, HMAC webhook, JWT).                                      |
| P4  | **Public surface tối thiểu**     | Chỉ 4 nhóm cổng được phép ra Internet: SSH (22), HTTP/HTTPS (80/443) qua nginx, và 2 cổng observability tạm thời của Node C (3001/9090).                                      |
| P5  | **Cấu hình là code**             | nginx config, prometheus/promtail/loki config, grafana provisioning, systemd unit — tất cả version-controlled trong repo (`crm-test/observability/`, `crm-test/grafana/`, …). |
| P6  | **VPC nội vùng (intra-region)**  | Mọi lưu lượng node↔node đi qua `eth1` (VPC `10.104.0.0/20`), không vòng ra Internet. Bắt buộc 3 droplet cùng region SGP1.                                                     |

---

## 2. Kiến trúc Networking toàn hệ thống

### 2.1. Sơ đồ tổng thể (5 node)

```
                                    ┌──────────────────────────────┐
              INTERNET              │   Bên ngoài (untrusted)       │
   Meta/Zalo webhooks, người dùng,  │                               │
   admin SSH, trình duyệt Grafana   └───────────────┬───────────────┘
                                                    │
        ┌───────────────────────────────┬──────────┴───────────┬─────────────────────┐
        │ :22 SSH                        │ :80/:443 HTTPS        │ :3001 / :9090       │
        │ (cả 3 node)                    │ (chỉ Node A nginx)    │ (chỉ Node C, tạm)   │
        ▼                                ▼                       ▼
 ┌───────────────────────────────────────────────────────────────────────────────────┐
 │                          VPC  default-sgp1   10.104.0.0/20                           │
 │                                                                                     │
 │  ┌─ NODE A — crm-service (10.104.0.2 / 167.172.77.62) ───────────────────────────┐  │
 │  │  EDGE:    nginx :80/:443  ──TLS term──►  upstream crm_api 10.104.0.2:3000      │  │
 │  │  APP:     docker crm-api  bind 10.104.0.2:3000  (net crm_api_net 172.25.0.0/16)│  │
 │  │  AGENTS:  node_exporter 10.104.0.2:9100 · promtail :9080 (push ra Node C)      │  │
 │  └───────────────┬──────────────────────────────────────┬────────────────────────┘  │
 │      27017/6379  │ (Mongo/Redis qua VPC)                 │ metrics/logs              │
 │                  ▼                                        ▼                           │
 │  ┌─ NODE B — crm-db (10.104.0.3 / 165.232.173.192) ──┐  ┌─ NODE C — crm-monitoring ─┐ │
 │  │  MongoDB rs0   bind 127.0.0.1,10.104.0.3:27017     │  │  (10.104.0.4/168.144...) │ │
 │  │  Redis 7       bind 127.0.0.1,10.104.0.3:6379      │  │  prometheus :9090        │ │
 │  │  node_exporter 10.104.0.3:9100                     │  │  grafana    :3001        │ │
 │  │  promtail :9080 (mongod+redis log → Node C)        │◄─┤  loki 10.104.0.4:3100    │ │
 │  └────────────────────────────────────────────────────┘  │  exporters 9121/9216/   │ │
 │                          ▲ scrape exporters/metrics qua VPC│           9100/8080     │ │
 │                          └─────────────────────────────────┤  k6 + simulator         │ │
 │                                                            └──────────────────────────┘ │
 └───────────────────────────────────────────────────────────────────────────────────┘
                  ▲
                  │ mongodump/mongorestore (one-time, public + Atlas allowlist)
            MongoDB Atlas (crm.sfh1nlk.mongodb.net) — prod gốc, chỉ đọc
```

### 2.2. Phân vùng tin cậy (Trust Zones)

| Zone                   | Thành phần                               | Ai được vào                                                   |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| **Public / Untrusted** | Internet                                 | —                                                             |
| **Edge (DMZ)**         | nginx Node A (:80/:443)                  | Bất kỳ ai (TLS, có security headers, rate-limit)              |
| **App tier**           | crm-api container (:3000)                | Chỉ nginx (cùng host) + Node C (VPC, để đo app thuần)         |
| **Data tier**          | Mongo (:27017), Redis (:6379) Node B     | Chỉ các node trong VPC `10.104.0.0/20`                        |
| **Observability tier** | Prometheus/Grafana/Loki/exporters Node C | Scrape nội bộ qua VPC; UI (3001/9090) tạm mở public cho admin |

### 2.3. Giao diện mạng mỗi droplet

| Interface | Địa chỉ                                                | Vai trò                                               |
| --------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `eth0`    | Public IP (vd `167.172.77.62`) + anchor `10.15.x.x/16` | Ra/vào Internet. Anchor IP là DO nội bộ — **bỏ qua**. |
| `eth1`    | VPC private `10.104.0.x/20`                            | **Toàn bộ traffic node↔node** đi qua đây.             |

Kiểm tra: `ip -4 -o addr show` → phải thấy `eth1` mang `10.104.0.x`.

> ⚠️ Khác region ⇒ không có VPC chung ⇒ buộc đi public IP (chậm + kém an toàn). **Luôn tạo cùng SGP1.**

### 2.4. Docker bridge networks (nội bộ từng container stack — Node A)

| Network               | Subnet          | Gateway      | Stack                                                                                |
| --------------------- | --------------- | ------------ | ------------------------------------------------------------------------------------ |
| `crm_api_net`         | `172.25.0.0/16` | `172.25.0.1` | crm-api (`172.25.0.10`); scaled: worker `.11`, omni-worker `.12`, email-worker `.13` |
| `crm_web_net`         | `172.26.0.0/16` | `172.26.0.1` | crm-web (`172.26.0.10`)                                                              |
| `crm_manager_api_net` | `172.27.0.0/16` | —            | crm-manager-api (`172.27.0.10`)                                                      |
| `crm_manager_web_net` | `172.28.0.0/16` | —            | crm-manager-web (`172.28.0.10`)                                                      |

> Gateway `172.25.0.1` xuất hiện ở header request từ nginx→container ⇒ phải có trong `METRICS_ALLOW_IPS` (xem §6.4).

---

## 3. Ma trận Port (Port Inventory)

**Quy ước cột "Phơi":** `LOCAL` = chỉ `127.0.0.1` · `VPC` = chỉ `10.104.0.0/20` · `PUBLIC` = ra Internet · `DOCKER` = chỉ trong docker bridge.

### Node A — crm-service (`10.104.0.2` / `167.172.77.62`)

| Port | Service          | Bind         | Phơi   | Lớp bảo vệ                         | Ai gọi                                  |
| ---- | ---------------- | ------------ | ------ | ---------------------------------- | --------------------------------------- |
| 22   | SSH (sshd)       | `0.0.0.0`    | PUBLIC | UFW + key-only, no-password        | Admin                                   |
| 80   | nginx HTTP       | `0.0.0.0`    | PUBLIC | redirect → 443                     | Internet                                |
| 443  | nginx HTTPS      | `0.0.0.0`    | PUBLIC | TLS + security headers + throttler | Internet, webhook Meta/Zalo             |
| 3000 | crm-api (docker) | `10.104.0.2` | VPC    | UFW (chỉ VPC) + JWT/HMAC           | nginx (upstream), Node C (đo app thuần) |
| 9100 | node_exporter    | `10.104.0.2` | VPC    | UFW (chỉ VPC)                      | Prometheus (Node C)                     |
| 9080 | promtail HTTP    | `0.0.0.0`*   | LOCAL  | (chỉ self-metrics, không UFW mở)   | — (push *ra* Loki)                      |

\* promtail chỉ phục vụ self-metrics; không mở UFW nên thực tế không reachable từ ngoài host.

> Stack production khác (nếu chạy trên Node A): crm-web `127.0.0.1:4200`, crm-manager-api `127.0.0.1:3001`, crm-manager-web `127.0.0.1:4201`, Keycloak `:8080`, Typebot builder `:8080`/viewer `:8081`. Tất cả publish `127.0.0.1` (trừ Keycloak/Typebot dùng `${PORT}`) → ra Internet qua nginx reverse-proxy, không bind public trực tiếp.

### Node B — crm-db (`10.104.0.3` / `165.232.173.192`)

| Port  | Service       | Bind                   | Phơi   | Lớp bảo vệ                           | Ai gọi                                    |
| ----- | ------------- | ---------------------- | ------ | ------------------------------------ | ----------------------------------------- |
| 22    | SSH           | `0.0.0.0`              | PUBLIC | UFW + key-only                       | Admin                                     |
| 27017 | MongoDB rs0   | `127.0.0.1,10.104.0.3` | VPC    | UFW + auth(SCRAM) + keyFile          | crm-api (Node A), exporter/probe (Node C) |
| 6379  | Redis 7       | `127.0.0.1,10.104.0.3` | VPC    | UFW + `requirepass` + protected-mode | crm-api (Node A), redis-exporter (Node C) |
| 9100  | node_exporter | `10.104.0.3`           | VPC    | UFW (chỉ VPC)                        | Prometheus (Node C)                       |
| 9080  | promtail      | local                  | LOCAL  | —                                    | push ra Loki                              |

### Node C — crm-monitoring (`10.104.0.4` / `168.144.128.121`)

| Port | Service           | Bind (compose)                 | Phơi         | Lớp bảo vệ                              | Ai gọi              |
| ---- | ----------------- | ------------------------------ | ------------ | --------------------------------------- | ------------------- |
| 22   | SSH               | `0.0.0.0`                      | PUBLIC       | UFW + key-only                          | Admin               |
| 9090 | Prometheus        | `127.0.0.1:9090`               | PUBLIC**     | UFW mở 9090 (admin)                     | Admin (UI)          |
| 3001 | Grafana           | `127.0.0.1:3001` (→ nginx TLS) | PUBLIC**     | UFW mở 3001 + Grafana login + nginx TLS | Admin (UI)          |
| 3100 | Loki              | `127.0.0.1` + `10.104.0.4`     | VPC          | UFW (chỉ VPC)                           | promtail (Node A/B) |
| 9096 | Loki gRPC         | (internal)                     | DOCKER       | —                                       | nội bộ Loki         |
| 9121 | redis-exporter    | `127.0.0.1:9121`               | LOCAL/DOCKER | scrape nội bộ                           | Prometheus          |
| 9216 | mongodb-exporter  | `127.0.0.1:9216`               | LOCAL/DOCKER | scrape nội bộ                           | Prometheus          |
| 9100 | node-exporter (C) | `127.0.0.1:9100`               | LOCAL/DOCKER | scrape nội bộ                           | Prometheus          |
| 8080 | cAdvisor          | `127.0.0.1:8080`               | LOCAL/DOCKER | scrape nội bộ                           | Prometheus          |

### Node D — crm-bot (`159.89.199.112`)

| Port | Service     | Bind      | Phơi   | Lớp bảo vệ          | Ai gọi        |
| ---- | ----------- | --------- | ------ | ------------------- | ------------- |
| 22   | SSH         | `0.0.0.0` | PUBLIC | UFW + key-only      | Admin         |
| 80   | nginx HTTP  | `0.0.0.0` | PUBLIC | redirect → 443      | Internet      |
| 443  | nginx HTTPS | `0.0.0.0` | PUBLIC | TLS + headers       | Internet      |
| 3000 | Bot service | `127.0.0.1`| LOCAL | nginx upstream only | nginx         |

### Node E — crm-livechat (`168.144.130.45`)

| Port | Service           | Bind       | Phơi   | Lớp bảo vệ          | Ai gọi                    |
| ---- | ----------------- | ---------- | ------ | ------------------- | ------------------------- |
| 22   | SSH               | `0.0.0.0`  | PUBLIC | UFW + password auth | Admin                     |
| 80   | nginx HTTP        | `0.0.0.0`  | PUBLIC | redirect → 443      | Internet                  |
| 443  | nginx HTTPS       | `0.0.0.0`  | PUBLIC | TLS Let's Encrypt   | Browser (widget embed)    |
| 4000 | crm-livechat (docker) | `127.0.0.1` | LOCAL | nginx upstream  | nginx                     |

> **Domain:** `livechat.crmsaudi.dev` → `168.144.130.45` (Node E)

\*\* **Lưu ý security:** compose publish Grafana/Prometheus ở `127.0.0.1` nhưng UFW lại mở 3001/9090 ra Internet để admin truy cập nhanh. Vì bind `127.0.0.1`, **port không thực sự reachable từ ngoài** trừ khi có reverse-proxy. Grafana production đi qua **nginx TLS → `https://grafana.crmsaudi.dev`**. → **Khuyến nghị siết:** gỡ rule UFW `3001/9090` allow-all, chỉ vào qua nginx TLS hoặc giới hạn IP admin (xem §5.4).

---

## 4. Bind-address & Docker port publishing

Quy tắc đọc một dòng `ports:` trong compose: `HOST_BIND:HOST_PORT:CONTAINER_PORT`.

| Dòng publish             | Ý nghĩa        | Reachable từ                   |
| ------------------------ | -------------- | ------------------------------ |
| `"3000:3000"`            | bind `0.0.0.0` | **Public** (NGUY HIỂM — tránh) |
| `"127.0.0.1:3000:3000"`  | bind loopback  | chỉ chính host                 |
| `"10.104.0.2:3000:3000"` | bind VPC IP    | các node trong VPC (kèm UFW)   |

**Quyết định thiết kế quan trọng:**
- crm-api đổi từ `127.0.0.1:3000` → `10.104.0.2:3000` để Node C bắn tải app thuần.
- Hệ quả: nginx upstream `127.0.0.1:3000` **chết** (502). → upstream phải trỏ `10.104.0.2:3000`.
- **Dài hạn (khuyến nghị):** publish **cả hai** `127.0.0.1:3000` + `10.104.0.2:3000` để vừa giữ nginx local vừa cho VPC — tránh tái diễn 502.

---

## 5. Firewall (UFW) — đặc tả rule từng node

**Chính sách mặc định (cả 3 node):** `default deny incoming`, `default allow outgoing`. Mọi cổng inbound phải khai báo tường minh.

### 5.1. Node A — crm-service

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH                                          # 22/tcp public
sudo ufw allow 80/tcp                                          # nginx HTTP (→ redirect 443)
sudo ufw allow 443/tcp                                         # nginx HTTPS (webhook + UI)
sudo ufw allow from 10.104.0.0/20 to any port 3000 proto tcp   # app thuần cho Node C
sudo ufw allow from 10.104.0.0/20 to any port 9100 proto tcp   # node_exporter ← Prometheus
sudo ufw --force enable
```

| Rule | Nguồn | Đích          | Lý do                          |
| ---- | ----- | ------------- | ------------------------------ |
| 22   | any   | SSH           | quản trị (key-only)            |
| 80   | any   | nginx         | redirect HTTPS / ACME http-01  |
| 443  | any   | nginx         | traffic chính + webhook        |
| 3000 | VPC   | app           | Node C đo app không qua nginx  |
| 9100 | VPC   | node_exporter | Prometheus scrape host metrics |

### 5.2. Node B — crm-db (siết chặt nhất — không port public ngoài SSH)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow from 10.104.0.0/20 to any port 27017 proto tcp  # MongoDB
sudo ufw allow from 10.104.0.0/20 to any port 6379  proto tcp  # Redis
sudo ufw allow from 10.104.0.0/20 to any port 9100  proto tcp  # node_exporter
sudo ufw --force enable
```

> Node B **tuyệt đối không** mở 27017/6379 ra public. Nếu cần migrate Atlas (§5 runbook) thì dùng *outbound* tới Atlas (đã `allow outgoing`), không cần inbound public.

### 5.3. Node C — crm-monitoring

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 3001/tcp                                        # Grafana UI (xem §5.4 để siết)
sudo ufw allow 9090/tcp                                        # Prometheus UI (xem §5.4)
sudo ufw allow from 10.104.0.0/20 to any port 3100 proto tcp   # Loki ← promtail A/B
sudo ufw --force enable
```

### 5.4. Khuyến nghị siết Node C (hardening)

Hai cổng UI mở all-IP là điểm yếu duy nhất còn lại. Chọn 1 trong 3:

```bash
# (a) Chỉ cho IP admin cố định
sudo ufw delete allow 3001/tcp ; sudo ufw delete allow 9090/tcp
sudo ufw allow from <ADMIN_IP> to any port 3001 proto tcp
sudo ufw allow from <ADMIN_IP> to any port 9090 proto tcp

# (b) Chỉ vào Grafana qua nginx TLS (đã có https://grafana.crmsaudi.dev), đóng 3001/9090,
#     prometheus truy cập qua SSH tunnel: ssh -L 9090:127.0.0.1:9090 deploy@168.144.128.121

# (c) Để nguyên nhưng dựa vào bind 127.0.0.1 của compose (port không thực reachable
#     từ ngoài dù UFW mở) — chấp nhận rủi ro thấp trong giai đoạn load-test.
```

### 5.4b. Node D — crm-bot

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

### 5.4c. Node E — crm-livechat

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Port 4000 chỉ bind 127.0.0.1 → nginx upstream, không cần UFW mở
sudo ufw --force enable
```

### 5.5. Tổng hợp ma trận firewall

| Cổng          | Node A | Node B | Node C              | Node D | Node E   |
| ------------- | ------ | ------ | ------------------- | ------ | -------- |
| 22 SSH        | public | public | public              | public | public   |
| 80/443        | public | —      | —                   | public | public   |
| 3000 app      | VPC    | —      | —                   | local  | —        |
| 27017 Mongo   | —      | VPC    | —                   | —      | —        |
| 6379 Redis    | —      | VPC    | —                   | —      | —        |
| 9100 node-exp | VPC    | VPC    | (local)             | —      | —        |
| 3100 Loki     | —      | —      | VPC                 | —      | —        |
| 3001/9090 UI  | —      | —      | public* (siết §5.4) | —      | —        |
| 4000 livechat | —      | —      | —                   | —      | local    |

---

## 6. Mô hình Security phòng thủ nhiều lớp

### 6.1. SSH

- **Key-only**: `PasswordAuthentication no`, `PermitRootLogin prohibit-password`.
- 1 keypair ed25519 chung (`~/.ssh/crm_nodeb`) cấp cho cả 3 node — đơn giản hoá load-test; production nên 1 key/người.
- User `deploy` (sudo NOPASSWD cho test infra — **siết lại** ở production).
- Sau khi cấp key: `passwd` đổi root password (có thể đã đi qua kênh kém an toàn).
- Kiểm chứng: `sudo sshd -T | grep -i passwordauthentication` = `no`.

### 6.2. Tầng dữ liệu (Node B)

| Cơ chế           | Cấu hình                                                                                             | Bảo vệ                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Mongo SCRAM auth | `security.authorization: enabled`                                                                    | chống truy cập không xác thực                                     |
| Mongo keyFile    | `/etc/mongodb-keyfile` (chmod 400, owner mongodb)                                                    | internal auth giữa member RS                                      |
| Mongo bind       | `127.0.0.1,10.104.0.3` (KHÔNG public)                                                                | giảm bề mặt tấn công                                              |
| User phân quyền  | `crm` = `readWrite@crm` + `crm_audit_logs`; `mongodb_exporter` = `clusterMonitor@admin`+`read@local` | least-privilege                                                   |
| Redis            | `requirepass`, `protected-mode yes`, bind VPC                                                        | chống truy cập ẩn danh                                            |
| Redis policy     | `maxmemory-policy noeviction`                                                                        | **không evict** key BullMQ/idempotency (đúng đắn > tiết kiệm RAM) |

### 6.3. Tầng Edge (nginx Node A)

- **TLS** Let's Encrypt (`*.crmsaudi.dev`), HTTP→HTTPS redirect.
- **Security headers** (từ `crm-web/nginx.conf`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, **HSTS** `max-age=31536000; includeSubDomains; preload`, **CSP** whitelist `*.crmsaudi.dev` + `wss/ws`.
- `client_max_body_size 50m` (cho import CSV/XLSX).
- **Rate limit ứng dụng** (`ThrottlerModule`): burst 10/s, medium 100/60s, long 500/15min, key theo IP.
  - Webhook `@Public()` phải `@SkipThrottle({burst,medium,long})` — nếu không, tải 1 IP chạm trần 429 → mất webhook. (Bare `@SkipThrottle()` vô tác dụng với named throttler.)

### 6.4. Tầng metrics (guard `/api/v1/metrics`)

Guard chỉ cho `127.0.0.1` + `METRICS_ALLOW_IPS`. Node listen dual-stack ⇒ app thấy IP **IPv6-mapped**. Phải allowlist đủ cả 4 dạng:

```
METRICS_ALLOW_IPS=10.104.0.4,172.25.0.1,::ffff:10.104.0.4,::ffff:172.25.0.1
```
(`10.104.0.4` = Prometheus Node C; `172.25.0.1` = docker gateway crm_api_net.)

### 6.5. Webhook integrity

- FB/IG: `x-hub-signature-256: sha256=HMAC_SHA256(rawBody, FACEBOOK_APP_SECRET)`.
- Zalo: `ZALO_OA_SECRET_KEY`. Verify token: `OMNI_VERIFY_TOKEN`.
- Secret trên Node C (load-test) **phải khớp** Node A, nếu không webhook 400/401.

### 6.6. Quản lý secret

| Mục                  | Vị trí                                          | Quyền              |
| -------------------- | ----------------------------------------------- | ------------------ |
| SSH key chung        | `~/.ssh/crm_nodeb` (máy admin)                  | 600                |
| Mongo/Redis password | `~/.ssh/crm_nodeb_secrets.env`                  | 600                |
| App env              | Node A `/var/www/crm-api/.env.production`       | gitignored         |
| Mongo keyFile        | Node B `/etc/mongodb-keyfile`                   | 400, owner mongodb |
| CI/CD secrets        | GitHub Actions Secrets (`VPS_*`, `DEPLOY_PATH`) | —                  |

- **Không commit secret.** CI/CD `crm-auth` từ chối deploy nếu phát hiện placeholder password (`change-me`, `admin`, …).
- Creds Atlas cũ nếu từng lộ qua chat/log ⇒ **rotate** trên Atlas.

### 6.7. CI/CD an toàn với cấu hình infra

- `crm-api/deploy.yml`: `git pull --ff-only` → `.env.production` (gitignored) và sửa đổi infra *uncommitted* trên `docker-compose.yml` **được giữ nguyên**.
- `crm-web/deploy.yml`: `git reset --hard origin/main` → **ghi đè** mọi sửa đổi local của crm-web. (Khác biệt cần lưu ý.)
- Kiểm: `sudo -u deploy git -C /var/www/crm-api status --short` để chắc edit infra còn nguyên.

---

## 7. Đặc tả setup từng Server

> Mục này mô tả *trạng thái cuối* của từng server (component nào, bind đâu, file config nào). Thao tác lệnh chi tiết: xem [runbook](devops-loadtest-infra.md) §2–§6.

### 7.1. Node A — crm-service (`10.104.0.2`)

**Vai trò:** SUT (System Under Test) — API + workers + edge.

| Lớp     | Component                                          | Cấu hình chính                                                                                                         | Nguồn                                               |
| ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| OS      | Ubuntu 24.04 LTS                                   | user `deploy` (CI/CD), UFW                                                                                             | —                                                   |
| Edge    | **nginx**                                          | `upstream crm_api { server 10.104.0.2:3000; }`; TLS LE; security headers; `client_max_body_size 50m`                   | `/etc/nginx/sites-available/default`                |
| App     | **crm-api** (docker)                               | image `crm-api:production`; bind `10.104.0.2:3000`; net `crm_api_net`; `mem_limit 2g`; healthcheck `/api/v1/health`    | `/var/www/crm-api/docker-compose.yml`               |
| App env | `.env.production`                                  | `DATABASE_URL`(+USERNAME/PASSWORD), `AUDIT_DATABASE_URL`, `WORKER_HOST` redis/1, `REDIS_PASSWORD`, `METRICS_ALLOW_IPS` | gitignored                                          |
| Metrics | **node_exporter** (docker `--net=host --pid=host`) | `--web.listen-address=10.104.0.2:9100`, `--path.rootfs=/host`                                                          | runbook §11.2                                       |
| Logs    | **promtail** 3.2.1 (docker)                        | docker_sd + nginx logs → `http://10.104.0.4:3100/loki/api/v1/push`                                                     | `crm-test/observability/node-a/promtail-config.yml` |

**Nguyên tắc bind:** app bind VPC IP (`10.104.0.2`), exporter bind VPC IP — không cái nào `0.0.0.0`. Chỉ nginx (80/443) public.

**Cảnh báo vận hành:** cadvisor chạy ở Node C ⇒ alert `container_*` **không phủ** container crm-api của Node A. Muốn theo dõi ⇒ cài thêm cadvisor trên Node A.

### 7.2. Node B — crm-db (`10.104.0.3`)

**Vai trò:** Data tier — MongoDB RS + Redis. Không docker (native systemd).

| Component                                                   | Cấu hình chính                                                                                                                                                | File                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **MongoDB 8.0**                                             | `bindIp: 127.0.0.1,10.104.0.3`; `authorization: enabled`; `keyFile`; `replSetName: rs0`; RS member `host:"10.104.0.3:27017"` (private IP, **không** hostname) | `/etc/mongod.conf`                                                     |
| **Redis 7**                                                 | `bind 127.0.0.1 10.104.0.3`; `protected-mode yes`; `requirepass`; `maxmemory-policy noeviction`                                                               | `/etc/redis/redis.conf`                                                |
| **node_exporter** (systemd, native binary)                  | `--web.listen-address=10.104.0.3:9100`; user `node_exporter`                                                                                                  | `crm-test/observability/node-b/node_exporter.service`                  |
| **promtail** (systemd, native, run as root để đọc log 0600) | `mongod.log` + `redis-server.log` → `http://10.104.0.4:3100/...`                                                                                              | `crm-test/observability/node-b/{promtail-config.yml,promtail.service}` |

**Vì sao native (không docker):** DB tier ưu tiên đơn giản/ổn định I/O, tránh lớp network docker. node_exporter/promtail cũng native để khớp.

**Connection strings thành phẩm:**
```
MONGO (app):   mongodb://crm:<PW>@10.104.0.3:27017/crm?authSource=crm&replicaSet=rs0
MONGO (audit): mongodb://crm:<PW>@10.104.0.3:27017/?authSource=crm&replicaSet=rs0
REDIS:         redis://:<PW>@10.104.0.3:6379   (app dùng /0 cache, /1 queue BullMQ)
```

### 7.3. Node C — crm-monitoring (`10.104.0.4`)

**Vai trò:** Monitoring + Observability hub. Toàn bộ qua docker compose (`/home/deploy/crm-test/docker-compose.test.yml`).

| Component            | Image                                     | Publish                              | Vai trò                                                                                                                                                               |
| -------------------- | ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **prometheus**       | `prom/prometheus:v2.54.1`                 | `127.0.0.1:9090`                     | scrape jobs: prometheus, redis(9121), mongodb(9216), crm-api(10.104.0.2:3000/api/v1/metrics), node(A/B/C:9100), cadvisor(8080). Reload: `docker exec ... kill -HUP 1` |
| **grafana**          | `grafana/grafana:11.2.0`                  | `127.0.0.1:3001`                     | volume bền `grafana_data`; provisioning datasource(uid prometheus+loki)/dashboards/alerting; SMTP env; nginx TLS → `grafana.crmsaudi.dev`                             |
| **loki**             | `grafana/loki:2.9.8`                      | `127.0.0.1:3100` + `10.104.0.4:3100` | filesystem tsdb v13, retention 7 ngày (168h), ingestion 16MB/s; gRPC 9096                                                                                             |
| **redis-exporter**   | `oliver006/redis_exporter:v1.62.0`        | `127.0.0.1:9121`                     | scrape Redis Node B qua `REDIS_URL`                                                                                                                                   |
| **mongodb-exporter** | `percona/mongodb_exporter:0.41`           | `127.0.0.1:9216`                     | `MONGO_EXPORTER_URI` user `mongodb_exporter`                                                                                                                          |
| **node-exporter**    | `quay.io/prometheus/node-exporter:v1.8.2` | `127.0.0.1:9100`                     | host metrics Node C                                                                                                                                                   |
| **cadvisor**         | `gcr.io/cadvisor/cadvisor:v0.49.1`        | `127.0.0.1:8080`                     | per-container metrics (chỉ Node C)                                                                                                                                    |
| **k6**               | `grafana/k6:0.53.0`                       | —                                    | load script `/scripts/*.js` (threshold v0.53: `p(95)` không `p95`)                                                                                                    |
| **tester**           | `node:20-alpine`                          | —                                    | scenario suite `npm run all`                                                                                                                                          |

**Grafana provisioning (file → code):**
- `grafana/provisioning/datasources/datasource.yml` — Prometheus (uid `prometheus`, default) + Loki (uid `loki`).
- `grafana/provisioning/dashboards/dashboards.yml` — provider trỏ `/var/lib/grafana/dashboards`.
- `grafana/provisioning/alerting/alerting.yml` — 6 rule + contact `crm-ops-email` (SMTP Gmail → `admin@crmsaudi.dev`).

**Dashboards:** CRM System Health (16 panel), Infrastructure Hosts, MongoDB rs0, Logs Central (Loki), CRM Omnichannel Load Test.

**Alert rules (folder Infrastructure):** High CPU (>80% crit), High Memory (>85% crit), Disk Low (>85% warn), Container High CPU (>90% warn, chỉ Node C), Container High Memory (>900MB warn), Redis Memory High (>80% crit). Định tuyến theo `severity`. Rule provisioned = **read-only trên UI**; sửa = sửa `alerting.yml` rồi recreate grafana.

**Load knobs** (`.env`): `CONCURRENT_USERS`, `WEBHOOKS_PER_MINUTE`, `STORM_USERS`, `AGENTS`. `REDIS_URL` phải có hậu tố `/1` (DB queue BullMQ) để `queue-probe.js` đọc đúng.

### 7.4. Node D — crm-bot (`159.89.199.112`)

**Vai trò:** Bot automation server (Typebot, n8n hoặc custom bot).

| Lớp  | Component        | Cấu hình chính                                              |
| ---- | ---------------- | ----------------------------------------------------------- |
| OS   | Ubuntu 22.04 LTS | UFW, SSH key-only                                           |
| Edge | **nginx**        | TLS LE; proxy → `127.0.0.1:3000`                            |
| App  | Bot service      | docker, bind `127.0.0.1:3000`                               |

### 7.5. Node E — crm-livechat (`168.144.130.45`)

**Vai trò:** Livechat widget CDN + WebSocket server. Standalone (không trong VPC SGP1).

| Lớp   | Component              | Cấu hình chính                                                                              |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------- |
| OS    | Ubuntu 22.04 LTS       | UFW (22/80/443 only), user `root`                                                           |
| Edge  | **nginx**              | TLS Let's Encrypt `livechat.crmsaudi.dev`; proxy_pass `http://127.0.0.1:4000`; WebSocket upgrade (`Upgrade`, `Connection`) |
| App   | **crm-livechat**       | docker image từ `ghcr.io/crmsaassaudi/crm-livechat:latest`; bind `127.0.0.1:4000`; env `VITE_API_URL`, `VITE_SOCKET_URL` |
| Cert  | certbot + nginx plugin | `certbot --nginx -d livechat.crmsaudi.dev`                                                  |

**Env vars cần thiết (`.env`):**
```
VITE_API_URL=https://api.crmsaudi.dev
VITE_SOCKET_URL=wss://api.crmsaudi.dev
PORT=4000
```

**Nginx config mẫu** (`/etc/nginx/sites-available/livechat`):
```nginx
server {
    listen 80;
    server_name livechat.crmsaudi.dev;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name livechat.crmsaudi.dev;
    ssl_certificate     /etc/letsencrypt/live/livechat.crmsaudi.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/livechat.crmsaudi.dev/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 8. Luồng dữ liệu (Data Flows)

### 8.1. Request thật (production)
```
Internet → :443 nginx (Node A, TLS term, headers, throttle)
        → upstream 10.104.0.2:3000 crm-api
        → Mongo 10.104.0.3:27017 (rs0, txn) / Redis 10.104.0.3:6379 (cache/0, queue/1)
        → BullMQ worker xử lý async
```

### 8.2. Webhook (Meta/Zalo)
```
Meta/Zalo → :443 nginx → /api/v1/omni/webhook/* (crm-api, @Public + @SkipThrottle)
         → verify HMAC (FACEBOOK_APP_SECRET) → enqueue omni-webhooks (Redis/1)
         → 200 {"status":"ok","queued":1}; worker → omni_messages (Mongo)
```

### 8.3. Metrics (pull)
```
Prometheus (Node C) ──scrape qua VPC──►
   node_exporter A 10.104.0.2:9100 · node_exporter B 10.104.0.3:9100
   crm-api 10.104.0.2:3000/api/v1/metrics (qua METRICS_ALLOW_IPS guard)
   redis-exporter:9121 · mongodb-exporter:9216 · cadvisor:8080 · node-exporter C:9100
```

### 8.4. Logs (push)
```
promtail Node A (docker_sd + nginx) ─┐
promtail Node B (mongod + redis)     ┼─push→ Loki 10.104.0.4:3100 → Grafana
```

### 8.5. Load test
```
k6/simulator (Node C) ──VPC──► crm-api 10.104.0.2:3000  (đo app thuần, bỏ qua nginx)
                              hoặc :443 nginx (đo full edge)
```

---

## 9. Checklist audit hạ tầng

**Networking**
- [ ] Mỗi node `ip -4 -o addr` có `eth1 10.104.0.x` (cùng VPC SGP1).
- [ ] Không service backend nào bind `0.0.0.0` (kiểm `ss -tlnp` từng node).

**Firewall**
- [ ] `sudo ufw status verbose` từng node khớp §5.1–5.3.
- [ ] Node B: KHÔNG có rule public cho 27017/6379.
- [ ] Node C: cân nhắc siết 3001/9090 (§5.4).

**Security**
- [ ] `sshd -T | grep passwordauthentication` = `no` (cả 3 node).
- [ ] Mongo: `authorization: enabled` + keyFile chmod 400 owner mongodb.
- [ ] Redis: `requirepass` set, `protected-mode yes`, `maxmemory-policy noeviction`.
- [ ] nginx trả security headers (`curl -I https://api.crmsaudi.dev` thấy HSTS/CSP/X-Frame).
- [ ] `METRICS_ALLOW_IPS` đủ 4 dạng IP (IPv4 + IPv6-mapped).
- [ ] Webhook burst >10 → tất cả 200 (throttle skip đúng).
- [ ] Không secret trong git; creds Atlas cũ đã rotate nếu nghi lộ.

**Health & Observability**
- [ ] `docker inspect crm-api --format '{{.State.Health.Status}}'` = healthy; log không `MongoServerError`.
- [ ] nginx upstream trỏ `10.104.0.2:3000` (không 502).
- [ ] Prometheus targets all `up`: node-a/b/c, crm-api, redis, mongodb, cadvisor.
- [ ] Grafana mở qua `https://grafana.crmsaudi.dev`; alert rules provisioned (6 rule).
- [ ] Loki nhận log từ cả Node A và B (query `{host="node-a"}` và `{host="node-b"}`).
- [ ] `rs.status().ok` = 1 trên Mongo; Redis `ping` = PONG qua VPC.

---

> **Liên quan:** [devops-loadtest-infra.md](devops-loadtest-infra.md) (runbook thao tác từng bước & nhật ký sự cố).
