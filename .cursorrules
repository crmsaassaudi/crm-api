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
  - **External/3rd-Party IDs:** MUST use `Id` suffix for partner/platform identifiers (e.g. `externalMessageId`, `facebookPageId`).
  - **Populated Objects:** DO NOT use `Id` suffix when returning a full object in DTOs/Business Logic (e.g. return `tenant` as a `TenantDto`).
  - **No Overwriting Populate & Virtuals Usage:** DO NOT use `.populate('tenantId')` to lazily overwrite a primitive string/ObjectId field with an object in Mongoose. To return populated data, you MUST either:
    - Define Mongoose Virtuals in the schema (e.g., define a `tenant` virtual field referencing `tenantId`) and use `.populate('tenant')`.
    - Explicitly map the fetched document to a new object field (`tenant: TenantDto`) in the Repository/Mapper layer before passing it to the Service layer.
- **Data Flow:**
  - Define explicit Request/Response DTOs for all endpoints.
  - Utilize `class-validator` decorators heavily in DTOs.
  - Map Mongoose documents to raw entities/objects before sending them back up to services (using `mappers` when appropriate).

## Operations & Scripts
- Before proposing any test automation scripts or running them, inspect the available scripts in `package.json`.
- Execute tests inside the respective sub-project (`npm run test`).
- Respect code formatting conventions. If you modify files automatically, check if running `npm run format` locally is required to conform to the Prettier guidelines.
