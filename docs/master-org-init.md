# Master Org Init — bootstrap tổ chức nội bộ

Script khởi tạo **1 lần** org "master" (tổ chức nội bộ của chúng ta) khi dựng hạ
tầng mới, thay cho việc bấm tay từng bước trong Keycloak + Mongo.

## Mô hình quyền (bối cảnh)

Hệ thống multi-tenant có **2 trục quyền độc lập**:

| Trục | Field | Giá trị | Ý nghĩa |
|---|---|---|---|
| Platform | `user.platformRole` | `SUPER_ADMIN` \| `USER` | `SUPER_ADMIN` = nhân sự nội bộ, **vào được manager-api/manager-web** |
| Tenant | `user.tenants[].roles` | `OWNER/ADMIN/MEMBER/VIEWER/GUEST` | quyền bên trong 1 tenant (nghiệp vụ CRM) |

- **Cổng manager-api** (`crm-manager-api` → `findAllowedManagerByKeycloakId`): chỉ cho
  qua nếu Mongo `users` có doc `{ keycloakId, platformRole: 'SUPER_ADMIN', status: ACTIVE }`.
- **Org master** = 1 tenant bình thường (data vẫn cô lập multi-tenant), **nhưng owner
  của nó có `platformRole = SUPER_ADMIN`** → vừa dùng CRM như khách, vừa quản trị hệ thống.
- Tenant khách khác: owner giữ `platformRole = USER` → không vào được manager.

Không có cờ `isMaster` trên tenant — "master" thuần tuý đến từ `platformRole` của owner.

## Script làm gì (idempotent)

`src/scripts/master-org/` — chạy qua NestJS standalone context, **tái dùng đúng**
`KeycloakAdminService` + schema Mongoose thật (không lệch với saga provisioning):

1. Keycloak Organization theo `alias` — find-or-create
2. Keycloak user (email admin) — find-or-create, password vĩnh viễn, `emailVerified=true`
3. Add user vào org (bỏ qua nếu đã là member)
4. Mongo `tenants` — find-or-create (plan ENTERPRISE, storage unlimited `-1`)
5. Mongo `users` — upsert: `platformRole=SUPER_ADMIN`, `status=active`,
   `onboardingStatus=COMPLETED`, membership `OWNER` của tenant master
6. `tenant.ownerId` = user
7. Ghim alias reservation `CONFIRMED` (không TTL-expire)

Chạy lại nhiều lần an toàn: chỉ lấp chỗ thiếu, không tạo trùng, không crash.

## Cách chạy

Trên máy/VPS có sẵn env của crm-api (`DATABASE_URL` + `KEYCLOAK_*` admin client):

```bash
# Dùng mặc định (CRM Saudi / master / nguyentoan102002@gmail.com, mật khẩu tự sinh)
npm run init:master-org

# Hoặc override qua env
MASTER_ORG_NAME="CRM Saudi" \
MASTER_ORG_ALIAS="master" \
MASTER_ADMIN_EMAIL="nguyentoan102002@gmail.com" \
MASTER_ADMIN_FULLNAME="CRM Saudi Admin" \
MASTER_ORG_PLAN="ENTERPRISE" \
npm run init:master-org
```

Trong Docker (image crm-api đã build) trên Node A:

```bash
docker compose -f docker-compose.yml --env-file .env.production \
  exec crm-api npm run init:master-org
```

### Biến môi trường

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `MASTER_ORG_NAME` | `CRM Saudi` | Tên tổ chức |
| `MASTER_ORG_ALIAS` | `master` | Subdomain → `master.crmsaudi.dev` |
| `MASTER_ORG_PLAN` | `ENTERPRISE` | `FREE`\|`PRO`\|`ENTERPRISE` |
| `MASTER_ADMIN_EMAIL` | `nguyentoan102002@gmail.com` | Email admin |
| `MASTER_ADMIN_FULLNAME` | `CRM Saudi Admin` | Họ tên |
| `MASTER_ADMIN_PASSWORD` | *(trống → tự sinh)* | Nếu để trống, script in mật khẩu mạnh 1 lần |

## Output

Khi tạo user mới, script **in mật khẩu 1 lần** ra stdout — lưu ngay vào password
manager. Nếu KC user đã tồn tại, script tái dùng và **không** đổi mật khẩu.

Sau khi chạy: đăng nhập `https://master.crmsaudi.dev/login` (CRM, vai trò OWNER)
và `https://manager.crmsaudi.dev` (quản trị hệ thống, SUPER_ADMIN) bằng cùng tài khoản.
