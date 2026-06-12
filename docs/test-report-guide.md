# Hướng dẫn chạy Test & xem Dashboard Report

## 📋 Tổng quan Commands

### Backend (`crm-api`) — Jest

| Command | Mục đích |
|---------|----------|
| `npm test` | Chạy tất cả test (console output) |
| `npm run test:unit` | Chỉ chạy unit test (loại e2e) |
| `npm run test:report` | ⭐ Chạy + sinh **HTML Dashboard Report** |
| `npm run test:report:cov` | Chạy + Dashboard + **Coverage** |
| `npm run test:cov` | Chạy + Coverage (không dashboard) |
| `npm run test:watch` | Watch mode (tự chạy lại khi code thay đổi) |
| `npm run test:debug` | Debug mode (runInBand, detectOpenHandles) |

### Frontend (`crm-web`) — Vitest

| Command | Mục đích |
|---------|----------|
| `npm test` | Chạy tất cả test (console output) |
| `npm run test:ui` | ⭐ **Dashboard tương tác** — mở browser tự động |
| `npm run test:report` | Sinh HTML report tĩnh |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Chạy + Coverage report |

---

## 🚀 Cách chạy toàn bộ test + xem Dashboard

### Backend — HTML Report (tĩnh)

```bash
cd crm-api
npm run test:report
```

Report sẽ được sinh ra tại: `jest_html_reporters.html` (root của project)

→ Mở file này trong trình duyệt để xem dashboard.

> **Tip:** Muốn có cả coverage trong report:
> ```bash
> npm run test:report:cov
> ```
> Coverage HTML report thêm tại: `coverage/lcov-report/index.html`

---

### Frontend — Interactive Dashboard (khuyên dùng)

```bash
cd crm-web
npm run test:ui
```

Vitest UI sẽ tự mở browser tại `http://localhost:51204/__vitest__/`

> **Vitest UI** là dashboard **tương tác** (live):
> - Xem chi tiết từng test suite, từng test case
> - Filter theo trạng thái (passed/failed/skipped)
> - Xem source code từng test ngay trong browser
> - Re-run từng test riêng lẻ
> - Xem graph module dependency

### Frontend — Static HTML Report

```bash
cd crm-web
npm run test:report
```

Report tại: `test-report/index.html`

Để xem report trong browser:
```bash
npx vite preview --outDir test-report
```

---

## 📊 Dashboard Features

### Backend Report (jest-html-reporters)
- **Summary bar**: Total suites, tests passed/failed, duration
- **Table view**: Mỗi spec file = 1 row, click mở chi tiết
- **Filter**: Filter theo status (Passed / Failed / Not Passed)
- **Info button**: Xem stack trace của test failed
- **Expand**: Click `+` để xem từng test case trong suite

### Frontend Report (Vitest UI)
- **Tree view**: File explorer bên trái, kết quả bên phải
- **Filter bar**: Search, filter by status
- **Code view**: Xem source code của test ngay trong UI
- **Module graph**: Xem dependency graph
- **Re-run**: Click nút ▶ để chạy lại từng test

---

## 🔧 Chạy một file test cụ thể

### Backend
```bash
# Chạy một file cụ thể
npx jest --testPathPatterns="users.service.spec" --maxWorkers=1

# Chạy tests match tên
npx jest --testNamePattern="should create user" --maxWorkers=1
```

### Frontend
```bash
# Chạy một file cụ thể
npx vitest run src/shared/hooks/usePermission.test.ts

# Chạy với filter tên
npx vitest run -t "should grant permission"
```

---

## ⚠️ Lưu ý

- Backend luôn dùng `--maxWorkers=50%` (đã cấu hình sẵn trong npm scripts) để tránh **OOM / StackOverflow**. Nếu chạy `npx jest` trực tiếp, nhớ thêm `--maxWorkers=1` hoặc `--maxWorkers=50%`.

- Report file (`jest_html_reporters.html`, `test-report/`, `coverage/`) đã được thêm vào `.gitignore` — không commit lên repo.

---

## 📁 Cấu trúc Test

```
crm-api/src/
├── test/                          # Shared test infrastructure
│   ├── factories/                 # Factory functions (createUser, createContact, ...)
│   ├── mocks/                     # Reusable mocks (redis, cls, queue, ...)
│   └── index.ts                   # Barrel export
├── contacts/contacts.service.spec.ts
├── tickets/tickets.service.spec.ts
├── users/users.service.spec.ts
├── deals/deals.service.spec.ts
├── accounts/accounts.service.spec.ts
├── common/permissions/permission.guard.spec.ts
├── roles/tenant-roles.guard.spec.ts
├── omni-outbound/outbound.service.spec.ts
├── omni-inbound/queue/webhook-processor.spec.ts
├── omni-inbound/queue/webhook-processor-phase2.spec.ts
├── utils/pagination.spec.ts
└── utils/escape-regex.spec.ts

crm-web/src/
├── shared/utils/validationUtils.test.ts
├── shared/hooks/usePermission.test.ts
└── shared/components/PermissionGuard.test.tsx
```

---

## 🏗️ Viết test mới

### Backend — Sử dụng shared infrastructure

```typescript
import { createUser } from '../test/factories/user.factory';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';

describe('MyService', () => {
  let cls = createClsMock();           // default: tenantId='tenant_1', userId='user_1'
  let eventEmitter = createEventBusMock();
  // ...
});
```

### Frontend — Vitest + Testing Library

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/shared/store/useCrmContext', () => ({ ... }));

describe('MyComponent', () => {
  it('should render', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
```
