# crm-api - AI Agent Convention Rules

You are an expert AI software engineer assisting in the development of the `crm-api` backend service for this project.

**Always strictly adhere to these architectural guidelines and coding standards when generating, refactoring, or reviewing code.**

## General Guidelines
- Validate your active directory. Ensure you are applying NestJS rules.
- Write clean, strongly typed TypeScript code. Avoid using `any` unless absolutely necessary.
- Prefer explicit null checks (`??`, `?.`) over loose equality or generic truthiness checks.
- Document complex logic, regexes, and domain-specific rules with JSDoc comments.
- Follow the exact file naming conventions and architectural patterns already established in the respective directories you are working in.

## Tech Stack Context
- **Framework:** NestJS 11 (TypeScript, SWC compiler).
- **Database:** Mongoose (MongoDB). Redis is used for caching.
- **Background Jobs:** BullMQ.
- **Validation:** `class-transformer`, `class-validator`.
- **Real-time:** `@nestjs/platform-socket.io`.

## Architecture Layering (DDD-Light approach)
Follow the existing modular structure (e.g., `src/omni-inbound`). Do not bypass layers.
1. **`controllers/`**: Handles incoming HTTP requests and returns responses. Strictly NO business logic here. Validation happens here via DTOs.
2. **`services/`**: Contains core application and business logic.
3. **`repositories/`**: Database abstraction layer (Repository Pattern). Controllers and Services **must not** inject Mongoose models directly; they must use Repositories to query/mutate data.
4. **`domain/`**: Pure domain structures and business entities/interfaces.
5. **`infrastructure/`**: Database schemas (Mongoose schemas), integrations with external APIs, mappers.
6. **`queue/` & `processors/`**: Background jobs implementations (BullMQ).
7. **`adapters/`**: For structural normalization (e.g., mapping raw webhooks to internal payloads).

## Coding Rules
- **Naming Conventions:**
  - Classes/Interfaces: `PascalCase` (e.g., `OmniInboundService`, `TenantDocument`).
  - Files: `kebab-case.type.ts` (e.g., `omni-inbound.service.ts`, `omni.controller.ts`, `tenant.schema.ts`).
  - Database Collections (Mongoose): MUST use lower `snake_case` in plural form (e.g., `@Schema({ collection: 'routing_rules' })`). Do NOT use `camelCase` (e.g., routingRules) or `PascalCase`.
- **Database Ref & ID Management (Predictability):**
  - **Internal References:** MUST use `Id` suffix for schema fields that refer to other collections (e.g. `tenantId`, `conversationId`). DO NOT use `tenant` or `conversation` at the schema level.
  - **Ref Type Standard:** Any schema field using Mongoose `ref` MUST declare `type: MongooseSchema.Types.ObjectId` (or `Types.ObjectId` equivalent). DO NOT use `type: String` for internal refs.
  - **External/3rd-Party IDs:** MUST use `Id` suffix for partner/platform identifiers (e.g. `externalMessageId`, `facebookPageId`).
  - **Populated Objects:** DO NOT use `Id` suffix when returning a full object in DTOs/Business Logic (e.g. return `tenant` as a `TenantDto`).
  - **No Overwriting Populate & Virtuals Usage:** DO NOT use `.populate('tenantId')` to lazily overwrite a primitive string/ObjectId field with an object in Mongoose. To return populated data, you MUST either:
    - Define Mongoose Virtuals in the schema (e.g., define a `tenant` virtual field referencing `tenantId`) and use `.populate('tenant')`.
    - Explicitly map the fetched document to a new object field (`tenant: TenantDto`) in the Repository/Mapper layer before passing it to the Service layer.
- **Data Flow:**
  - Define explicit Request/Response DTOs for all endpoints.
  - Utilize `class-validator` decorators heavily in DTOs.
  - Map Mongoose documents to raw entities/objects before sending them back up to services (using `mappers` when appropriate).

## Common Pitfalls

### ⚠️ Mongoose Subdocument / Populated Document → "Maximum call stack size exceeded"

**Triệu chứng:** API trả về `500 Internal Server Error` với message `"Maximum call stack size exceeded"`, thường xảy ra ở các file `*.mapper.ts`.

**Nguyên nhân gốc:**

Khi mapper gán trực tiếp một Mongoose array (subdocument) hoặc populated document vào domain entity mà **không chuyển đổi sang plain object**, các cấu trúc nội bộ của Mongoose (`$__`, `$parent`, circular refs) sẽ bị duyệt đệ quy vô hạn bởi chuỗi interceptor:

```
ClassSerializerInterceptor (instanceToPlain)
  → ResolvePromisesInterceptor (deepResolvePromises)
    → NormalizeIdInterceptor (recursive normalize)
```

**Các trường hợp HAY GẶP:**

1. **Subdocument arrays** (ví dụ: `omniIdentities`, `tenants`, hoặc bất kỳ embedded array nào có `_id` tự sinh):
   ```typescript
   // ❌ SAI – gán trực tiếp Mongoose DocumentArray (có circular refs)
   domainEntity.omniIdentities = raw.omniIdentities ?? [];

   // ✅ ĐÚNG – map sang plain object, chỉ lấy field cần thiết
   domainEntity.omniIdentities = (raw.omniIdentities || []).map((el: any) => ({
     channelType: el.channelType,
     senderId: el.senderId?.toString(),
   }));
   ```

2. **Populated documents** (virtual populate hoặc ref populate):
   ```typescript
   // ⚠️ CẨN THẬN – populated document là Mongoose doc, có thể gây lỗi
   // nếu UserMapper không xử lý đúng
   if ((raw as any).owner) {
     domainEntity.owner = UserMapper.toDomain((raw as any).owner);
   }
   ```

**Quy tắc chung cho Mapper:**
- **KHÔNG BAO GIỜ** gán trực tiếp Mongoose array/subdocument vào domain entity.
- **LUÔN LUÔN** `.map()` tạo plain object mới cho embedded arrays.
- Với populated documents, cân nhắc dùng `.toObject()` nếu mapper downstream có vấn đề.
- Dùng `.toString()` cho tất cả ObjectId fields (`ownerId`, `createdById`, `tenantId`, v.v.).

---

## Operations & Scripts
- Before proposing any test automation scripts or running them, inspect the available scripts in `package.json`.
- Execute tests inside the respective sub-project (`npm run test`).
- Respect code formatting conventions. If you modify files automatically, check if running `npm run format` locally is required to conform to the Prettier guidelines.
