# CRM Omnichannel — Load-Test Infrastructure (DevOps Runbook)

> Triển khai thực tế ngày **2026-06-13** trên DigitalOcean, region **SGP1**.
> Tài liệu này ghi lại **từng bước** đã làm để dựng môi trường load-test 3 node, đủ để dựng lại từ đầu (hoặc audit lại).

---

## 0. Tổng quan kiến trúc

Môi trường load-test tách biệt khỏi production, gồm **3 droplet** cùng một **VPC** để gọi nhau qua mạng nội bộ (private), không phơi DB/Redis ra Internet.

```
                         VPC default-sgp1  (10.104.0.0/20)
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                    │
   │   Node A — crm-service            Node B — crm-db                  │
   │   10.104.0.2 (private)            10.104.0.3 (private)             │
   │   167.172.77.62 (public)          165.232.173.192 (public)         │
   │   ┌─────────────────────┐         ┌──────────────────────────┐     │
   │   │ CRM API + workers   │────────▶│ MongoDB 8.0 (RS rs0)      │     │
   │   │ (docker, nginx)     │  27017  │ Redis 7 (auth, noevict)   │     │
   │   └─────────────────────┘  6379   └──────────────────────────┘     │
   │            ▲                                                        │
   │            │ webhook (HMAC) :3000                                   │
   │            │                                                        │
   │   ┌────────┴────────────┐                                          │
   │   │ Node C — crm-loadtest│                                         │
   │   │ 10.104.0.4 (private) │   k6 + simulators                       │
   │   │ 159.89.199.112 (pub) │   Prometheus :9090 / Grafana :3001      │
   │   └─────────────────────┘   redis-exporter :9121                   │
   │                                                                    │
   └──────────────────────────────────────────────────────────────────┘
                  ▲
                  │ mongodump/mongorestore (one-time migrate)
            MongoDB Atlas (crm.sfh1nlk.mongodb.net)  — prod gốc, giữ nguyên
```

### Bảng node

| Node | Hostname | Private IP | Public IP | Spec | Vai trò |
|---|---|---|---|---|---|
| A | crm-service | `10.104.0.2` | `167.172.77.62` | 2 vCPU / 8 GB | CRM API + BullMQ workers (SUT) |
| B | crm-db | `10.104.0.3` | `165.232.173.192` | 2 vCPU / 4 GB | MongoDB (replica set) + Redis |
| C | crm-loadtest | `10.104.0.4` | `159.89.199.112` | 2 vCPU / 4 GB | k6/simulator + Prometheus/Grafana |

- **OS**: Ubuntu 24.04 LTS (noble), tất cả.
- **Droplet type**: Premium AMD (NVMe SSD, dedicated-ish CPU) khuyến nghị để P95/P99 ổn định.
- **Nguyên tắc vàng**: load generator (Node C) **luôn tách** khỏi SUT (Node A).

---

## 1. VPC & Networking (DigitalOcean)

DigitalOcean tự gán mỗi droplet vào **VPC mặc định của region**. Cả 3 node tạo trong **SGP1** nên cùng VPC `default-sgp1`, dải `10.104.0.0/20`.

- Giao diện mạng trên mỗi droplet:
  - `eth0` = public IP + một anchor IP `10.15.x.x/16` (DO nội bộ, bỏ qua).
  - `eth1` = **VPC private IP** `10.104.0.x/20` ← cái ta dùng để các node gọi nhau.
- Kiểm tra trên mỗi máy:
  ```bash
  ip -4 -o addr show        # tìm eth1 10.104.0.x
  ```
- **Không cần cấu hình VPC thủ công** nếu 3 droplet cùng region. Chỉ cần đảm bảo cùng region khi tạo.

> ⚠️ Nếu các node ở **khác region** → không gọi private được, buộc phải đi public IP (kém an toàn, chậm hơn). Luôn tạo cùng region.

---

## 2. Quy ước chung: user `deploy` + SSH key

Trên mỗi node (B và C) tạo user `deploy` với sudo + đăng nhập bằng SSH key (không password). Node A đã có sẵn user `deploy` (do CI/CD).

### 2.1. Tạo 1 keypair dùng chung cho cả 3 node (trên máy quản trị)
```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/crm_nodeb -C "crm-deploy"
cat ~/.ssh/crm_nodeb.pub        # copy public key
```

### 2.2. Cấp key cho từng node (chạy 1 lần, nhập password root của máy đó)
```bash
ssh root@<PUBLIC_IP> "mkdir -p ~/.ssh && echo '<PUBLIC_KEY>' >> ~/.ssh/authorized_keys && \
  chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo OK"
```

### 2.3. Tạo user `deploy` (Node B & C) — chạy bằng root qua key
```bash
ssh -i ~/.ssh/crm_nodeb root@<PUBLIC_IP> bash -s <<EOF
set -e
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-deploy   # test infra; siết lại nếu cần
chmod 440 /etc/sudoers.d/90-deploy
mkdir -p /home/deploy/.ssh
echo '<PUBLIC_KEY>' > /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
EOF
```

### 2.4. Hardening SSH (đã áp dụng cho Node B)
```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true
sudo systemctl restart ssh
sudo sshd -T | grep -i '^passwordauthentication'   # phải = no
```

> 🔐 Sau khi cấp key xong, **đổi mật khẩu root** đã dùng (`passwd`) — vì nó có thể đã đi qua kênh không an toàn.

---

## 3. Node B — MongoDB + Redis (`10.104.0.3`)

### 3.1. Cài MongoDB 8.0 (hỗ trợ noble 24.04)
```bash
ssh -i ~/.ssh/crm_nodeb deploy@165.232.173.192 bash -s <<'EOF'
set -e
sudo apt-get update -qq
sudo apt-get install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor --yes
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt-get update -qq
sudo apt-get install -y mongodb-org
sudo systemctl enable --now mongod
EOF
```

### 3.2. Tạo user Mongo (chạy lúc auth chưa bật — localhost exception)
```bash
mongosh --quiet --eval '
  db = db.getSiblingDB("admin");
  db.createUser({user:"admin", pwd:"<MONGO_ADMIN_PW>", roles:[{role:"root", db:"admin"}]});
  db = db.getSiblingDB("crm");
  db.createUser({user:"crm", pwd:"<MONGO_APP_PW>", roles:[{role:"readWrite", db:"crm"}]});
'
```

### 3.3. Bật auth + bind vào private IP
Sửa `/etc/mongod.conf`:
```yaml
net:
  port: 27017
  bindIp: 127.0.0.1,10.104.0.3        # KHÔNG bind public IP
security:
  authorization: enabled
```
```bash
sudo systemctl restart mongod
```

### 3.4. Convert sang **single-node replica set** (BẮT BUỘC)
> App CRM dùng MongoDB **transactions** (`database/transaction-manager.service.ts`). Transaction chỉ chạy trên replica set. Mongo standalone sẽ ném lỗi `Transaction numbers are only allowed on a replica set member`. Atlas vốn là RS nên trước giờ chạy được.

Replica set + auth ⇒ cần **keyFile** cho internal auth (kể cả single-node):
```bash
# 1. keyfile
sudo bash -c 'openssl rand -base64 756 > /etc/mongodb-keyfile'
sudo chmod 400 /etc/mongodb-keyfile
sudo chown mongodb:mongodb /etc/mongodb-keyfile
```
Thêm vào `/etc/mongod.conf`:
```yaml
security:
  authorization: enabled
  keyFile: /etc/mongodb-keyfile
replication:
  replSetName: rs0
```
```bash
sudo systemctl restart mongod
# initiate, ADVERTISE private IP để app/container kết nối được
mongosh -u admin -p '<MONGO_ADMIN_PW>' --authenticationDatabase admin --eval '
  rs.initiate({_id:"rs0", members:[{_id:0, host:"10.104.0.3:27017"}]})
'
```
> ❗ Phải `host: "10.104.0.3:27017"` (private IP). Nếu để mặc định, RS sẽ advertise hostname `crm-db` — container trên Node A không resolve được.

### 3.5. Cấp quyền audit DB cho user `crm`
App ghi audit sang DB riêng `crm_audit_logs`:
```bash
mongosh -u admin -p '<MONGO_ADMIN_PW>' --authenticationDatabase admin --eval '
  db.getSiblingDB("crm").grantRolesToUser("crm",[{role:"readWrite", db:"crm_audit_logs"}])
'
```

### 3.6. Cài + cấu hình Redis 7
```bash
sudo apt-get install -y redis-server
```
Sửa `/etc/redis/redis.conf`:
```
bind 127.0.0.1 10.104.0.3
protected-mode yes
requirepass <REDIS_PW>
maxmemory-policy noeviction      # KHÔNG evict key BullMQ/idempotency
```
```bash
sudo systemctl enable --now redis-server
sudo systemctl restart redis-server
```

### 3.7. Firewall (UFW) — chỉ mở cho VPC
```bash
sudo ufw allow OpenSSH
sudo ufw allow from 10.104.0.0/20 to any port 27017 proto tcp
sudo ufw allow from 10.104.0.0/20 to any port 6379  proto tcp
sudo ufw --force enable
sudo ufw status verbose
```

### 3.8. Connection string thành phẩm (dán vào Node A & C)
```
MONGO (app):   mongodb://crm:<MONGO_APP_PW>@10.104.0.3:27017/crm?authSource=crm&replicaSet=rs0
MONGO (audit): mongodb://crm:<MONGO_APP_PW>@10.104.0.3:27017/?authSource=crm&replicaSet=rs0
REDIS:         redis://:<REDIS_PW>@10.104.0.3:6379
```

---

## 4. Node A — repoint CRM app sang Node B (`10.104.0.2`)

App được deploy bằng **CI/CD** (GitHub Actions `deploy.yml` → SSH vào VPS → `docker build` → `docker compose up`). Container `crm-api` (image `crm-api:production`), compose tại `/var/www/crm-api/docker-compose.yml`, env tại `/var/www/crm-api/.env.production` (**gitignored**).

### 4.1. ⚠️ Ba cạm bẫy đã gặp khi đổi DB/Redis

1. **Mongoose `user`/`pass` ghi đè URI.** `mongoose-config.service.ts` truyền cả `uri`, `user`, `pass`. Nếu chỉ đổi `DATABASE_URL` mà quên `DATABASE_USERNAME`/`DATABASE_PASSWORD` (đang là creds Atlas cũ) → auth fail. **Phải đổi cả ba.**
2. **`docker-compose.yml` block `environment:` thắng `env_file`.** `REDIS_HOST: host.docker.internal` set cứng trong compose ⇒ sửa `.env.production` không có tác dụng, phải sửa trong compose.
3. **Cần `&replicaSet=rs0`** trong URI cho transaction; và khi sửa file env bằng `sed`, ký tự `&` trong replacement bị `sed` hiểu là "toàn bộ match" → **dùng Python để ghi, đừng dùng `sed`** cho chuỗi có `&`.

### 4.2. Backup trước khi sửa
```bash
cd /var/www/crm-api
cp -n .env.production .env.production.bak-nodeb
cp -n docker-compose.yml docker-compose.yml.bak-nodeb
```

### 4.3. Sửa `.env.production` (dùng Python, an toàn với ký tự `&`)
```bash
python3 - <<'PY'
vals = {
  "DATABASE_URL":       "mongodb://crm:<MONGO_APP_PW>@10.104.0.3:27017/crm?authSource=crm&replicaSet=rs0",
  "AUDIT_DATABASE_URL": "mongodb://crm:<MONGO_APP_PW>@10.104.0.3:27017/?authSource=crm&replicaSet=rs0",
  "DATABASE_USERNAME":  "crm",
  "DATABASE_PASSWORD":  "<MONGO_APP_PW>",
  "DATABASE_NAME":      "crm",
  "WORKER_HOST":        "redis://:<REDIS_PW>@10.104.0.3:6379/1",
  "REDIS_PASSWORD":     "<REDIS_PW>",
}
seen=set(); out=[]
for line in open(".env.production").read().splitlines():
    k=line.split("=",1)[0].strip() if "=" in line else None
    if k in vals: out.append(f"{k}={vals[k]}"); seen.add(k)
    else: out.append(line)
for k,v in vals.items():
    if k not in seen: out.append(f"{k}={v}")
open(".env.production","w").write("\n".join(out)+"\n")
PY
```

### 4.4. Sửa `docker-compose.yml` (Redis host trong block `environment:`)
```bash
sed -i "s|REDIS_HOST: host.docker.internal|REDIS_HOST: 10.104.0.3|" docker-compose.yml
```
> Ghi nhớ Redis DB: `REDIS_CACHE_DB=0` (cache/locks/pubsub), `REDIS_QUEUE_DB=1` (BullMQ).

### 4.5. Test kết nối từ container TRƯỚC khi restart
```bash
# Redis
docker run --rm --network crm_api_net redis:7-alpine \
  redis-cli -h 10.104.0.3 -a '<REDIS_PW>' --no-auth-warning ping        # PONG

# Mongo + transaction (chứng minh RS hoạt động)
docker run --rm --network crm_api_net mongo:8.0 mongosh \
  "mongodb://crm:<MONGO_APP_PW>@10.104.0.3:27017/crm?authSource=crm&replicaSet=rs0" \
  --quiet --eval 'const s=db.getMongo().startSession(); s.startTransaction();
    s.getDatabase("crm").t.insertOne({x:1}); s.commitTransaction(); db.t.deleteMany({}); print("TXN_OK")'
```

### 4.6. Restart app
```bash
docker compose up -d --force-recreate crm-api
docker inspect crm-api --format 'Health={{.State.Health.Status}}'      # healthy
docker logs crm-api --tail 30    # tìm "Nest application successfully started", không có MongoServerError
```

### 4.7. Mở port app ra VPC để Node C bắn tải trực tiếp
Mặc định compose publish `127.0.0.1:3000:3000` (chỉ localhost) → Node C không gọi tới được. Webhook thật đi qua nginx (80/443); nhưng để **đo app thuần (không nhiễu nginx)**, publish port app lên private IP:
```bash
sed -i "s|'127.0.0.1:3000:3000'|'10.104.0.2:3000:3000'|" docker-compose.yml
docker compose up -d --force-recreate crm-api
sudo ufw allow from 10.104.0.0/20 to any port 3000 proto tcp   # no-op nếu ufw inactive
```
> Bind vào `10.104.0.2` (private) chứ không phải `0.0.0.0` ⇒ không phơi ra public.

### 4.8. Rate-limiter (throttler) — đã sửa qua CI/CD
Endpoint webhook `@Public()` nhưng dính global `ThrottlerModule` (named throttlers `burst 10/s`, `medium 100/60s`, `long 500/15min`, key theo IP). Load test từ **1 IP** chạm trần ngay (429). Webhook Meta thật đến từ nhiều IP nên ít dính, **nhưng** burst từ vài IP của Meta vẫn có thể 429 → mất webhook. Fix (commit vào repo, CI/CD deploy):

```ts
// src/omni-inbound/controllers/inbound.controller.ts
import { SkipThrottle } from '@nestjs/throttler';

@Controller({ path: 'omni/webhook', version: '1' })
@Public()
// Bare @SkipThrottle() chỉ skip throttler tên "default" (không tồn tại ở đây) → no-op.
// Phải skip đích danh từng named throttler:
@SkipThrottle({ burst: true, medium: true, long: true })
export class InboundController { ... }
```
> Bài học: với **named throttlers**, `@SkipThrottle()` không tham số là **vô tác dụng**.

### 4.9. CI/CD có ghi đè cấu hình infra trên VPS không?
`deploy.yml` chạy `git pull --ff-only origin main`. Vì:
- `.env.production` **gitignored** → không bị đụng.
- `docker-compose.yml` tracked nhưng các sửa đổi infra (REDIS_HOST, ports) là **uncommitted trên VPS**; commit deploy chỉ đụng file source khác → `--ff-only` không chạm `docker-compose.yml` → **edit được giữ nguyên**.

> Vẫn nên: sau mỗi lần lo ngại, kiểm tra `sudo -u deploy git -C /var/www/crm-api status --short` để chắc các sửa đổi infra còn nguyên.

---

## 5. Migrate dữ liệu Atlas → Node B (one-time)

Cài tools trên Node B (repo MongoDB đã thêm ở §3.1):
```bash
sudo apt-get install -y mongodb-database-tools
```
> Atlas cần allowlist IP public của Node B (Network Access). Nếu lỗi timeout → thêm `165.232.173.192` (hoặc tạm `0.0.0.0/0`).

Quy trình an toàn (stop app → dump → restore --drop → start app):
```bash
# 1. stop app (Node A)
ssh ... root@167.172.77.62 "cd /var/www/crm-api && docker compose stop crm-api"

# 2. dump + restore (Node B). Restore bằng admin để tránh vướng quyền.
ATLAS="mongodb+srv://<user>:<pass>@crm.sfh1nlk.mongodb.net"
DEST="mongodb://admin:<MONGO_ADMIN_PW>@10.104.0.3:27017/?authSource=admin&replicaSet=rs0"
mongodump  --uri="$ATLAS" --db=crm            --gzip --archive=/tmp/crm.archive
mongodump  --uri="$ATLAS" --db=crm_audit_logs --gzip --archive=/tmp/audit.archive
mongorestore --uri="$DEST" --gzip --archive=/tmp/crm.archive   --drop --nsInclude='crm.*'
mongorestore --uri="$DEST" --gzip --archive=/tmp/audit.archive --drop --nsInclude='crm_audit_logs.*'
rm -f /tmp/*.archive

# 3. start app (Node A)
ssh ... root@167.172.77.62 "cd /var/www/crm-api && docker compose start crm-api"
```
> `mongodump --db=X` không dump `system.users` (user nằm ở `admin.system.users`) → `--drop` **không** xoá user `crm`. An toàn.
>
> Atlas gốc **không bị đụng** (chỉ đọc). App sau migrate chạy trên Node B với đầy đủ dữ liệu.

---

## 6. Node C — Load generator + Observability (`10.104.0.4`)

### 6.1. Cài Docker
```bash
ssh -i ~/.ssh/crm_nodeb deploy@159.89.199.112 bash -s <<'EOF'
command -v docker || (curl -fsSL https://get.docker.com | sudo sh)
sudo usermod -aG docker deploy
sudo systemctl enable --now docker
EOF
```

### 6.2. Đẩy bộ test framework `crm-test`
```bash
# từ máy có source (loại trừ node_modules/logs/test-result)
tar czf /tmp/crm-test.tgz --exclude=node_modules --exclude=.git \
  --exclude=test-result --exclude=logs -C <path> crm-test
scp -i ~/.ssh/crm_nodeb /tmp/crm-test.tgz deploy@159.89.199.112:/home/deploy/
ssh -i ~/.ssh/crm_nodeb deploy@159.89.199.112 \
  "cd /home/deploy && tar xzf crm-test.tgz && rm crm-test.tgz"
```

### 6.3. Cấu hình `.env` (`/home/deploy/crm-test/.env`)
```env
CRM_BASE_URL=http://10.104.0.2:3000          # Node A app qua VPC
API_PREFIX=api
FACEBOOK_APP_SECRET=<META_APP_SECRET>        # PHẢI khớp Node A, nếu không webhook 400
ZALO_OA_SECRET_KEY=<ZALO_SECRET>
OMNI_VERIFY_TOKEN=<VERIFY_TOKEN>
FB_PAGE_ID=<page id của 1 channel Connected>  # để channel resolution thành công
TENANT_ID=<tenant id thật>
REDIS_URL=redis://:<REDIS_PW>@10.104.0.3:6379/1   # /1 = DB queue BullMQ (queue-probe đọc đúng)
REDIS_PASSWORD=<REDIS_PW>
MONGO_URL=mongodb://crm:<MONGO_APP_PW>@10.104.0.3:27017/crm?authSource=crm&replicaSet=rs0
MONGO_DB=crm
GRAFANA_PASSWORD=admin
# Load knobs — chỉnh theo 2 vCPU của Node A (ramp dần tìm điểm gãy)
CONCURRENT_USERS=50
WEBHOOKS_PER_MINUTE=1500
STORM_USERS=500
AGENTS=20
```
> ⚠️ Queue BullMQ ở **Redis DB1**. Để `queue-probe.js` đọc đúng, `REDIS_URL` phải có hậu tố `/1`.

### 6.4. Bật stack observability + firewall
```bash
cd /home/deploy/crm-test
sudo ufw allow OpenSSH
sudo ufw allow 3001/tcp   # Grafana
sudo ufw allow 9090/tcp   # Prometheus
sudo ufw --force enable
docker compose -f docker-compose.test.yml up -d prometheus grafana redis-exporter
```
- Prometheus scrape `redis-exporter:9121` (kết nối Redis Node B) + `crm-api` (10.104.0.2:3000, sửa target trong `prometheus/prometheus.yml`).
- Grafana: `http://159.89.199.112:3001` (admin/admin, anonymous bật sẵn).
- `mongodb-exporter` **tắt** (bản M0/Atlas cũ không cho `clusterMonitor`); với Mongo self-host RS này có thể bật lại nếu cần.

---

## 7. Chạy load test

```bash
ssh -i ~/.ssh/crm_nodeb deploy@159.89.199.112
cd crm-test
# k6 ramp (lưu ý threshold k6 v0.53: dùng p(95) không phải p95)
docker compose -f docker-compose.test.yml run --rm k6 run /scripts/load.js
# full scenario suite (functional + correctness + queue)
docker compose -f docker-compose.test.yml run --rm tester npm run all
```

### Kiểm chứng pipeline 1 webhook (smoke)
Gửi 1 FB webhook đã ký HMAC vào app, rồi verify Mongo + queue:
```bash
# trên Node A (hoặc Node C trỏ 10.104.0.2): POST /api/v1/omni/webhook/facebook
#   header x-hub-signature-256: sha256=HMAC_SHA256(rawBody, FACEBOOK_APP_SECRET)
# kỳ vọng: 200 {"status":"ok","queued":1}
# rồi: crm.omni_messages có doc externalMessageId = mid; bull:omni-webhooks:completed +1
```

---

## 8. Quản lý secret & rollback

### Secrets (lưu ngoài repo)
| Mục | Vị trí |
|---|---|
| SSH key dùng chung | `~/.ssh/crm_nodeb` (máy quản trị) |
| Mongo/Redis password | `~/.ssh/crm_nodeb_secrets.env` (chmod 600) |
| App env | Node A `/var/www/crm-api/.env.production` (gitignored) |
| Mongo keyFile | Node B `/etc/mongodb-keyfile` (chmod 400) |

> 🔐 Không commit secret. Nếu creds Atlas cũ từng lộ qua chat/log → rotate trên Atlas.

### Rollback (đưa app về Atlas/Redis cũ)
```bash
cd /var/www/crm-api
cp -f .env.production.bak-nodeb .env.production
cp -f docker-compose.yml.bak-nodeb docker-compose.yml
docker compose up -d --force-recreate crm-api
```

---

## 9. Checklist xác minh end-to-end

- [ ] `ip -4 -o addr` mỗi node có `eth1 10.104.0.x` (cùng VPC).
- [ ] Node B: `mongosh "<MONGO_URL>" --eval 'rs.status().ok'` = 1; Redis `ping` = PONG (qua private IP).
- [ ] Node A: `docker inspect crm-api --format '{{.State.Health.Status}}'` = healthy; log không có `MongoServerError`.
- [ ] Node A log có `RedisEvictionPolicyGuard: ... noeviction` + `OmniGateway: Subscribed to Redis...` (Redis Node B OK).
- [ ] Node C: `curl http://10.104.0.2:3000/api/v1/health` = 200.
- [ ] Burst >10 webhook → tất cả 200 (throttle đã skip).
- [ ] Prometheus targets: `redis` = up; Grafana mở được.

---

## 10. Phụ lục — sự cố đã gặp & cách xử lý

| Sự cố | Nguyên nhân | Cách xử lý |
|---|---|---|
| App `Authentication failed` dù URI đúng | Mongoose `user/pass` (= `DATABASE_USERNAME/PASSWORD` Atlas cũ) ghi đè URI | Đổi cả `DATABASE_USERNAME/PASSWORD` sang creds Node B |
| Redis vẫn trỏ localhost dù sửa `.env` | `environment:` trong compose thắng `env_file` | Sửa `REDIS_HOST` trong `docker-compose.yml` |
| Transaction lỗi | Mongo standalone | Convert single-node replica set + keyFile |
| `.env` hỏng sau `sed` | `&` trong replacement = "toàn bộ match" | Dùng Python ghi file thay vì `sed` |
| Webhook 429 khi load test | Global throttler key theo IP, tải từ 1 IP | `@SkipThrottle({burst,medium,long})` cho webhook controller |
| `@SkipThrottle()` không tác dụng | Named throttlers, không có "default" | Skip đích danh từng tên |
| k6 `failed parsing threshold` | k6 v0.53 cú pháp | Dùng `p(95)<800` thay vì `p95<800` |
| Node C không gọi được app | App publish `127.0.0.1:3000` | Publish `10.104.0.2:3000` + UFW mở 3000 cho VPC |
| `git ... dubious ownership` | chạy git bằng root trên repo của `deploy` | `sudo -u deploy git -C /var/www/crm-api ...` |
| **502 Bad Gateway** toàn site (api/*.crmsaudi.dev) | nginx upstream `crm_api` trỏ `127.0.0.1:3000` nhưng container chỉ bind `10.104.0.2:3000` (đổi lúc mở VPC) → `connect() refused`. App vẫn healthy. | Sửa `upstream crm_api { server 10.104.0.2:3000; }` trong `/etc/nginx/sites-available/default` → `nginx -t && systemctl reload nginx`. (Dài hạn: bind container cả `127.0.0.1:3000` + `10.104.0.2:3000`.) |
| Prometheus scrape `/api/v1/metrics` bị 403 mỗi 5s | Guard chỉ cho localhost + `METRICS_ALLOW_IPS`; Node listen dual-stack nên app thấy IP **IPv6-mapped** `::ffff:172.25.0.1` (docker-gw), không khớp IPv4 thuần | `METRICS_ALLOW_IPS=10.104.0.4,172.25.0.1,::ffff:10.104.0.4,::ffff:172.25.0.1` trong Node A `.env.production` |
| Provisioned contact point `no uid is set` | Export `/api/.../contact-points` ra `uid: ""`; provisioning bắt buộc uid | Gán `uid:` non-empty trong `contact-points`/`alerting.yml` |
| Alert provisioning `conflict ... title should be unique` | `grafana_data` volume giữ rule cũ trùng title (khác uid) | Xoá volume `crm-test_grafana_data` rồi recreate (mọi thứ provision lại từ file) |

---

## 11. Observability & Alerting — stack giám sát theo từng node

> Dựng 2026-06-13. Triết lý: **metrics + logs + alerts** đều là **code** (provisioning/compose/file), Grafana có volume bền nên recreate không mất gì. Prometheus + Grafana + Loki tập trung ở **Node C**; mỗi node chạy agent đẩy về.

### 11.0. Sơ đồ luồng
```
Node A (app)    node_exporter:9100 (host) ─┐ metrics
                promtail (docker_sd+nginx) ─┼────────────┐
Node B (db)     node_exporter:9100 (host) ─┤ metrics     │
                promtail (mongod+redis log)─┼──── logs ───┤
                mongod/redis  (exporters scrape qua VPC)  │
Node C (obs)    prometheus:9090 ◄── scrape: node-a/b/c, crm-api, redis-exporter,
                                            mongodb-exporter, cadvisor
                loki:3100  ◄── promtail (A,B)
                grafana:3001 (datasource Prometheus+Loki; dashboards+alerting provisioned)
                  └─ nginx TLS → https://grafana.crmsaudi.dev
```

### 11.1. Node C — trung tâm (Prometheus + Grafana + Loki + exporters)
Tất cả trong `docker compose -f docker-compose.test.yml` (`/home/deploy/crm-test`):
- **prometheus** `:9090` — scrape jobs: `prometheus`, `redis` (redis-exporter:9121), `mongodb` (mongodb-exporter:9216), `crm-api` (10.104.0.2:3000/api/v1/metrics), `node` (node-a/b/c :9100), `cadvisor` (cadvisor:8080). Reload sau khi sửa: `docker exec crm-test-prometheus-1 kill -HUP 1` (HTTP `/-/reload` trả 403 vì lifecycle-API tắt).
- **grafana** `:3001` — volume bền `grafana_data:/var/lib/grafana`; provisioning: datasources (uid `prometheus`+`loki`), dashboards (folder file), **alerting** (`grafana/provisioning/alerting/alerting.yml`). SMTP qua env `GF_SMTP_*` ← `.env` (`SMTP_*`). nginx reverse-proxy + Let's Encrypt → `https://grafana.crmsaudi.dev`.
- **loki** `:3100` (`127.0.0.1` + `10.104.0.4` VPC) — filesystem, tsdb v13, retention 7 ngày, volume `loki_data`. UFW mở 3100 từ `10.104.0.0/20`.
- **mongodb-exporter** `:9216` — `MONGO_EXPORTER_URI` (user `mongodb_exporter`, role `clusterMonitor`).
- **redis-exporter** `:9121`, **node-exporter** `:9100` (host của Node C), **cadvisor** `:8080` (per-container).

Deploy/redeploy:
```bash
cd /home/deploy/crm-test
docker compose -f docker-compose.test.yml up -d prometheus grafana loki \
  redis-exporter mongodb-exporter node-exporter cadvisor
```

### 11.2. Node A (app) — node_exporter + promtail
```bash
# node_exporter (host metrics, bind riêng VPC IP — không lộ public)
docker run -d --name node-exporter --restart unless-stopped --net=host --pid=host \
  -v /:/host:ro,rslave quay.io/prometheus/node-exporter:v1.8.2 \
  --path.rootfs=/host --web.listen-address=10.104.0.2:9100
# promtail (PHẢI 3.x — 2.9 docker client API 1.42 quá cũ): docker logs + nginx logs → Loki
docker run -d --name promtail --restart unless-stopped \
  -v /var/www/observability/promtail-config.yml:/etc/promtail/config.yml:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro -v /var/log/nginx:/var/log/nginx:ro \
  grafana/promtail:3.2.1 -config.file=/etc/promtail/config.yml
```
Config: `crm-test/observability/node-a/promtail-config.yml`.

### 11.3. Node B (db) — node_exporter + promtail (native systemd, KHÔNG docker)
```bash
# node_exporter binary + systemd, bind VPC IP; UFW mở 9100 từ VPC
/usr/local/bin/node_exporter --web.listen-address=10.104.0.3:9100   # via systemd
# promtail binary + systemd (chạy root để đọc log 0600): mongod.log + redis-server.log → Loki
/usr/local/bin/promtail -config.file=/etc/promtail/config.yml       # via systemd
sudo ufw allow from 10.104.0.0/20 to any port 9100 proto tcp
```
Config + unit: `crm-test/observability/node-b/{promtail-config.yml,promtail.service,node_exporter.service}`.
User giám sát Mongo: `mongodb_exporter` (roles `clusterMonitor@admin` + `read@local`), pw ở `~/.ssh/crm_nodeb_secrets.env`.

### 11.4. Dashboards (provisioned từ `grafana/dashboards/`)
| Dashboard | Nội dung |
|---|---|
| CRM System Health | tổng quan CPU/RAM/Disk/Net/Containers/Redis/CRM API (16 panel) |
| Infrastructure — Hosts | node_exporter A/B/C: CPU%, RAM%, disk-IO-util (saturation), load, net, disk usage |
| MongoDB (Node B rs0) | ops/sec, doc ops, avg latency, connections, **global lock queue**, mem, DB size |
| Logs — Central (Loki) | error-rate tổng hợp + log crm-api/nginx/mongo/redis, ô filter |
| CRM Omnichannel Load Test | redis ops/evicted, mongo opcounters (dùng khi chạy tải) |

### 11.5. Alerting (provisioned — `alerting.yml`)
6 rule (folder Infrastructure): High CPU/Memory (crit, >80/85%), Disk Low (warn >85%), Container High CPU/Memory (warn), Redis Memory High (crit >80%). Định tuyến theo `severity` → contact `crm-ops-email` → SMTP Gmail → `admin@crmsaudi.dev`. Sửa rule = sửa `alerting.yml` rồi recreate grafana (rule provisioned **read-only** trên UI).

> ⚠️ **Lưu ý vận hành:** alert `container_*` chỉ phủ container **trên Node C** (cadvisor chạy ở Node C). Muốn theo dõi container crm-api (Node A) cần cài thêm cadvisor trên Node A.

---

## 12. crm-bot (Typebot fork) — deploy trên Node C

> Dựng 2026-06-13. crm-bot là service chatbot multi-tenant (fork Typebot v3.16.1, monorepo Bun + Next.js).
> Luồng: crm-api (Node A) nhận message omnichannel → BullMQ → `POST {CRM_BOT_URL}/api/bot/typebot/reply`
> trên **viewer** crm-bot → trả `{messages, status}` → crm-api gửi reply về khách. Bot là worker thuần,
> KHÔNG truy cập Mongo CRM, KHÔNG gọi Meta API. crm-api là orchestrator.

### 12.0. Topology
```
Node A crm-api ──(VPC HTTP)──▶ 10.104.0.4:4203  viewer  /api/bot/typebot/reply
                              10.104.0.4:4202  builder (UI tạo flow, SSO Keycloak)
                              10.104.0.4:3002  workflows (Bun, export/onboarding RPC)
Public:  https://bot.crmsaudi.dev → builder · https://chat.crmsaudi.dev → viewer  (nginx 443 + LE)
Datastore (self-contained trên Node C, network crm_bot_net):
  crm-bot-db (postgres:16) · crm-bot-redis (redis:7, requirepass) · crm-bot-minio (S3)
```

### 12.1. Source & build
- Deploy dir: `/home/deploy/crm-bot` (rsync từ local `e:/CRM/crm-bot`, exclude node_modules/.next/.git/.nx/.tanstack/dist).
- Compose: `docker-compose.prod.yml` (6 service) + `.env.prod` (từ `.env.prod.example`, **không commit**).
- builder/viewer build từ Dockerfile gốc qua `ARG SCOPE` (+ `scripts/{scope}-entrypoint.sh`); builder entrypoint tự chạy `prisma migrate deploy`. workflows build từ `apps/workflows/Dockerfile` (Bun).
- **Swap bắt buộc**: Node C chỉ 3.8GB RAM → thêm swapfile 4GB (`/swapfile`, trong `/etc/fstab`) trước khi build, nếu không build Next.js sẽ OOM. Build **tuần tự từng service** để giảm peak RAM.
- Chạy: `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`.

### 12.2. Env (.env.prod) — điểm chính
- `ENCRYPTION_SECRET` phải **đúng 32 ký tự**. `CRM_BOT_INTERNAL_SECRET` **phải khớp** giá trị trên Node A.
- `NEXTAUTH_URL=https://bot.crmsaudi.dev`, `NEXT_PUBLIC_VIEWER_URL=https://chat.crmsaudi.dev` (khớp redirect URI Keycloak).
- Keycloak: client `crm-bot`, `KEYCLOAK_ISSUER=https://auth.crmsaudi.dev/realms/crm-saas`, `CRM_BOT_SSO_LOCKDOWN=true`.
- DB/Redis/S3 trỏ service nội bộ: `crm-bot-db:5432`, `crm-bot-redis:6379/0`, `crm-bot-minio:9000` (bucket `typebot`, prefix `/public` để public).

### 12.3. UFW + nginx + TLS
- UFW: `allow from 10.104.0.0/20 to any port 4202,4203,3002 proto tcp` (cho Node A + nội bộ). KHÔNG mở public trực tiếp — đi qua nginx.
- nginx vhost (reuse pattern grafana.crmsaudi.dev): `bot.crmsaudi.dev`→`10.104.0.4:4202`, `chat.crmsaudi.dev`→`10.104.0.4:4203`. `certbot --nginx -d bot.crmsaudi.dev -d chat.crmsaudi.dev`.

### 12.4. Đấu nối Node A (crm-api)
- `/var/www/crm-api/.env.production`: thêm `CRM_BOT_URL=http://10.104.0.4:4203` + `CRM_BOT_INTERNAL_SECRET=<đồng bộ>`. Resolver: `crm-api/src/omni-inbound/bot/bot-api.service.ts` (`CRM_BOT_URL` → `BOT_SERVICE_URL` → fallback `localhost:4203`). Redeploy crm-api.

> ⚠️ **Lưu ý vận hành:** crm-bot chạy **cùng Node C** với load generator + observability → tổng RAM rất chật (~3.8GB). Theo dõi `docker stats`; nếu load-test nặng cân nhắc tách bot sang node riêng để không nhiễu kết quả đo.

### 12.5. Build gotchas (gặp khi deploy lần đầu 2026-06-13 — đã fix trong source)
1. **nx out-of-sync**: `nx build` báo "workspace is out of sync" và **fail** ở chế độ non-interactive (Docker). Fix: thêm `RUN bunx nx sync` trước `nx build` trong `Dockerfile`.
2. **Type error production build**: thay đổi multi-tenant làm `isWriteTypebotForbidden(typebot, user)` yêu cầu `user: Pick<User,"id"|"email">`. Production build chạy `tsc` (dev bỏ qua) → fail ở `handleDeleteResults.ts` và `generateUploadUrl.ts` (truyền user thiếu `email`). Đã fix 2 caller; 6 caller khác truyền `user` từ context orpc (đã có email).
3. **CRLF entrypoint**: `scripts/{builder,viewer}-entrypoint.sh` nếu có CRLF (checkout/copy từ Windows) → container `exit 127` "`./entrypoint.sh: not found`" (shebang `/bin/bash\r`). Fix: `Dockerfile` strip CRLF (`sed -i 's/\r$//'`) trước `chmod +x`; `.gitattributes` ép `*.sh eol=lf`. workflows không dính (dùng `ENTRYPOINT ["bun",...]`).
4. **workflows cần SMTP**: nodemailer layer của workflows **bắt buộc** `SMTP_HOST/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD/NEXT_PUBLIC_SMTP_FROM` (Config.string, không default) → thiếu sẽ crash `ConfigError SMTP_HOST`. Đã thêm vào `.env.prod` (reuse Gmail creds từ crm-test/.env, port 587, secure=false).
5. **Build chậm + cache**: builder/viewer images ~6GB (release copy full node_modules). Build tuần tự trên Node C ~12'/app (có swap). **Sửa file trong build context bust cache `COPY . .` → rebuild full.** Để vá nhanh 1 file đã build (vd entrypoint) mà không rebuild: `docker build -t <image> -` từ FROM image cũ + `RUN sed/tr` (layer vài giây).
