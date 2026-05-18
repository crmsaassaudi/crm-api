# CRM API deployment setup

Huong dan nay dung cho `crm-api` tren VPS Ubuntu, domain `crmsaudi.dev`, Nginx va SSL chay truc tiep tren host, Redis chay tren host port `6379`, MongoDB dung Atlas.

## 1. Kien truc deploy

- GitHub Actions SSH vao VPS bang `appleboy/ssh-action`.
- VPS pull code moi nhat cua branch `main` vao thu muc deploy.
- Docker Compose build image production va restart container `crm-api`.
- Nginx tren host reverse proxy vao `127.0.0.1:3000`.
- Container ket noi Redis host qua `host.docker.internal`, duoc map bang `host-gateway`.
- Docker network duoc co dinh subnet `172.25.0.0/16` de tranh xung dot address pool khi VPS chay nhieu project.

## 2. Chuan bi VPS

Cap nhat server va cai cac goi can thiet:

```bash
sudo apt update
sudo apt install -y git ca-certificates curl
```

Cai Docker Engine va Docker Compose plugin theo tai lieu Docker, sau do kiem tra:

```bash
docker --version
docker compose version
```

Tao user deploy neu chua co:

```bash
sudo adduser deploy
sudo usermod -aG docker deploy
```

Dang nhap lai SSH bang user `deploy` de group `docker` co hieu luc.

Tao thu muc deploy:

```bash
sudo mkdir -p /var/www/crm-api
sudo chown -R deploy:deploy /var/www/crm-api
```

Clone repository vao VPS. Neu repository private, xem phan deploy key ben duoi truoc.

```bash
cd /var/www
git clone git@github.com:<ORG_OR_USER>/<REPO>.git crm-api
cd /var/www/crm-api
git checkout main
```

Neu dung `FILE_DRIVER=local`, tao thu muc upload cho container. Dockerfile dang chay app bang UID/GID `10001`.

```bash
cd /var/www/crm-api
mkdir -p files
sudo chown -R 10001:10001 files
```

## 3. Key 1: GitHub Actions SSH vao VPS

Tao SSH key tren may local hoac tren VPS admin machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-crm-api" -f ./github-actions-crm-api
```

Them public key vao VPS:

```bash
ssh-copy-id -i ./github-actions-crm-api.pub deploy@<VPS_IP>
```

Neu khong dung duoc `ssh-copy-id`, them noi dung file `.pub` vao:

```bash
/home/deploy/.ssh/authorized_keys
```

Kiem tra SSH:

```bash
ssh -i ./github-actions-crm-api deploy@<VPS_IP>
```

Noi dung private key `github-actions-crm-api` se duoc luu vao GitHub Secret `VPS_SSH_PRIVATE_KEY`.

## 4. Key 2: VPS pull code tu GitHub

Tren VPS, dang nhap bang user `deploy` va tao deploy key:

```bash
ssh-keygen -t ed25519 -C "vps-crm-api-deploy-key" -f ~/.ssh/crm_api_github_deploy
```

Tao SSH config:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com-crm-api
  HostName github.com
  User git
  IdentityFile ~/.ssh/crm_api_github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Them public key vao GitHub repository:

```bash
cat ~/.ssh/crm_api_github_deploy.pub
```

Vao GitHub repository: `Settings` -> `Deploy keys` -> `Add deploy key`.

- Title: `vps-crm-api`
- Key: noi dung file `.pub`
- Allow write access: khong can bat

Neu remote hien tai la `git@github.com:<ORG_OR_USER>/<REPO>.git`, doi sang host alias:

```bash
cd /var/www/crm-api
git remote set-url origin git@github.com-crm-api:<ORG_OR_USER>/<REPO>.git
git fetch origin main
```

## 5. Tao file .env.production tren VPS

Khong luu secrets production trong repository. Tao file nay truc tiep tren VPS:

```bash
cd /var/www/crm-api
nano .env.production
chmod 600 .env.production
```

Mau toi thieu:

```dotenv
NODE_ENV=production
APP_PORT=3000
APP_NAME="CRM API"
API_PREFIX=api
APP_FALLBACK_LANGUAGE=en
APP_HEADER_LANGUAGE=x-custom-lang
APP_ROOT_DOMAIN=crmsaudi.dev
FRONTEND_DOMAIN=https://crmsaudi.dev,https://*.crmsaudi.dev
BACKEND_DOMAIN=https://crmsaudi.dev

DATABASE_TYPE=mongodb
DATABASE_URL=mongodb+srv://<USER>:<PASSWORD>@<CLUSTER>/<DB_NAME>?retryWrites=true&w=majority
DATABASE_NAME=<DB_NAME>

REDIS_HOST=host.docker.internal
REDIS_PORT=6379
REDIS_PASSWORD=<REDIS_PASSWORD>
REDIS_DB=0
WORKER_HOST=redis://:<REDIS_PASSWORD>@host.docker.internal:6379/1
REDIS_REQUIRE_NOEVICTION=false
REDIS_AUTO_FIX_EVICTION_POLICY=false

FILE_DRIVER=local

AUTH_JWT_SECRET=<GENERATE_STRONG_SECRET>
AUTH_JWT_TOKEN_EXPIRES_IN=15m
AUTH_REFRESH_SECRET=<GENERATE_STRONG_SECRET>
AUTH_REFRESH_TOKEN_EXPIRES_IN=3650d
AUTH_FORGOT_SECRET=<GENERATE_STRONG_SECRET>
AUTH_FORGOT_TOKEN_EXPIRES_IN=30m
AUTH_CONFIRM_EMAIL_SECRET=<GENERATE_STRONG_SECRET>
AUTH_CONFIRM_EMAIL_TOKEN_EXPIRES_IN=1d

KEYCLOAK_AUTH_SERVER_URL=https://auth.crmsaudi.dev
KEYCLOAK_REALM=<REALM>
KEYCLOAK_CLIENT_ID=<CLIENT_ID>
KEYCLOAK_CLIENT_SECRET=<CLIENT_SECRET>
KEYCLOAK_CALLBACK_URL=https://crmsaudi.dev/api/v1/auth/callback
KEYCLOAK_FRONTEND_URL=https://crmsaudi.dev
```

Tao secret manh:

```bash
openssl rand -base64 48
```

Neu Redis tren host chi bind `127.0.0.1`, container se khong ket noi duoc qua `host.docker.internal`. Khi do can cau hinh Redis bind them IP bridge Docker hoac IP host noi bo, va gioi han firewall chi cho phep container subnet `172.25.0.0/16` truy cap.

## 6. GitHub Secrets can tao

Vao GitHub repository: `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`.

Bat buoc:

- `VPS_HOST`: IP hoac hostname VPS.
- `VPS_USERNAME`: user SSH, vi du `deploy`.
- `VPS_SSH_PRIVATE_KEY`: noi dung private key cua `github-actions-crm-api`.
- `DEPLOY_PATH`: `/var/www/crm-api`.

Tuy chon:

- `VPS_SSH_PORT`: port SSH, mac dinh workflow dung `22` neu khong khai bao.

Khong can dua MongoDB URI, Redis password, JWT secret vao GitHub Actions neu chung da nam trong `/var/www/crm-api/.env.production` tren VPS.

## 7. Nginx reverse proxy mau

Nginx dang co SSL tren host, chi can proxy API vao port local:

```nginx
server {
    listen 443 ssl http2;
    server_name crmsaudi.dev;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Kiem tra va reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Chay lan dau tren VPS

```bash
cd /var/www/crm-api
docker compose build --pull api-service
docker compose up -d api-service
docker compose logs -f api-service
```

Sau do moi lan push vao branch `main`, GitHub Actions se tu dong SSH vao VPS, pull code, build image va restart container.
