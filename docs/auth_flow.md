# Authentication Flow Documentation

## Overview
The current system implements a **Hybrid Authentication Model**. It integrates Keycloak as an Identity Provider (IdP) but primarily relies on a local JWT strategy for API protection in specific modules.

## 1. Global vs. Local Guards

### Global Configuration (`app.module.ts`)
The application registers `KeycloakConnectModule` and sets `AuthGuard` (from `nest-keycloak-connect`) as a global guard:
```typescript
providers: [
  {
    provide: APP_GUARD,
    useClass: AuthGuard, // Validates Keycloak Access Tokens
  },
  // ...
]
```
This means by default, **every** endpoint expects a valid Keycloak Access Token in the `Authorization` header, unless explicitly public.

### Local Overrides (`UsersController`)
Specific controllers, like `UsersController`, use standard NestJS Passport guards:
```typescript
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class UsersController { ... }
```
-   `AuthGuard('jwt')` uses `JwtStrategy`, which validates **locally signed tokens** (issued by `AuthService`), NOT Keycloak tokens.
-   This creates a potential conflict or duality where some endpoints might require Keycloak tokens (global default) while others require local tokens (explicit decorators).

## 2. Authentication Flows

### A. Local Email/Password Login
1.  **User** sends credentials to `POST /auth/email/login`.
2.  **AuthService** verifies credentials against the local `User.password` (bcrypt hash).
3.  **AuthService** issues a **Local JWT** signed with `AUTH_SECRET`.
4.  **User** uses this Local JWT to access API endpoints guarded by `AuthGuard('jwt')`.

### B. Social / Keycloak Login
1.  **Frontend** (presumed) performs OAuth2 flow with Keycloak/Social Provider.
2.  **Frontend** sends the provider's token or profile data to `POST /auth/social/login`.
3.  **AuthService** (`validateSocialLogin`):
    -   Verifies if a user exists with the `keycloakId` (mapped from Social ID).
    -   If not, creates a new `User` entity linked to the `keycloakId`.
    -   If exists, updates the user.
4.  **AuthService** issues a **Local JWT** (session).
5.  **User** uses the Local JWT for subsequent API requests.

## 3. Keycloak Integration Role
Currently, Keycloak acts primarily as an **external source of truth** for identity creation (via `TenantsService`) and potentially for endpoints relying *solely* on the global `AuthGuard`.

-   **TenantsService**: Creates a Realm User in Keycloak and a local Shadow User.
-   **UsersService**: Maps local users to Keycloak via `keycloakId` field.

## 4. Current Architecture Diagram
```mermaid
graph TD
    Client[Client App]
    
    subgraph "NestJS Backend"
        GlobalGuard[Global AuthGuard (Keycloak)]
        LocalGuard[AuthGuard('jwt') (Passport)]
        AuthService
        Repo[Users Repository]
    end
    
    subgraph "Identity Provider"
        Keycloak[Keycloak Server]
    end

    Client -- "1. Login Credentials" --> AuthService
    AuthService -- "2. Validate" --> Repo
    AuthService -- "3. Issue Local JWT" --> Client
    
    Client -- "4. Request + Local JWT" --> LocalGuard
    LocalGuard -- "5. Validate Local Signature" --> AuthService
    
    Client -- "Request + Keycloak Token" --> GlobalGuard
    GlobalGuard -- "Validate Token" --> Keycloak
```

## 5. Recommendations
The current hybrid state (requiring Keycloak integration but using local tokens) can be confusing.
-   **Standardize**: Decide whether to fully offload auth to Keycloak (Resource Server pattern) OR keep Keycloak as just a syncing backend.
-   **If Keycloak-First**: Remove `AuthGuard('jwt')` and `JwtStrategy`. Rely entirely on `nest-keycloak-connect` guards and standard Keycloak tokens.
-   **If Sync-Only**: Remove global `nest-keycloak-connect` guards to prevent accidental blocking of local tokens on non-overridden endpoints.
