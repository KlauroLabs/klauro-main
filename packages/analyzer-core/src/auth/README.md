# Klauro Authentication System

## Current Implementation

The active NestJS authentication module currently provides email/password registration and login with JWT tokens.

Implemented files:

- `auth.module.ts` wires `AuthController`, `AuthService`, `JwtStrategy`, Passport, JWT, and MikroORM repositories.
- `auth.controller.ts` exposes the public auth endpoints.
- `auth.service.ts` creates users, verifies passwords, creates an optional organization on registration, and returns signed access/refresh tokens.
- `guards/jwt-auth.guard.ts` protects controllers that opt into JWT auth.
- `strategies/jwt.strategy.ts` reads bearer tokens from the `Authorization` header.

There are older or standalone files in this folder, including `auth-service.ts`, OAuth strategy helpers, and Express-style middleware. Those files are not the active Nest controller surface unless they are explicitly wired into `auth.module.ts` or another module.

## Product Role

Auth protects saved analyses, workspaces, teams, and collaboration features. It is not part of CAS itself. CAS should describe auth behavior in analyzed codebases, while this module protects the Klauro product.

## Implemented Endpoints

The backend sets the global API prefix to `/api`, so the active endpoints are:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Register a user and optionally create an organization |
| `POST` | `/api/auth/login` | Login with email and password |

No refresh, logout, OAuth callback, email verification, password reset, or API-key endpoints are currently exposed by `AuthController`.

## Registration Flow

1. Validate the request DTO.
2. Reject duplicate email addresses.
3. Hash the password with bcrypt.
4. Create the user with free billing tier and incomplete onboarding.
5. If `organizationName` is provided, create an organization and owner membership.
6. Return an access token, refresh token, token type, expiry, and user payload.

## Login Flow

1. Find the user by email.
2. Reject missing users and users without a password hash.
3. Compare the supplied password with bcrypt.
4. Update `lastLoginAt`.
5. Return an access token, refresh token, token type, expiry, and user payload.

## Token Behavior

`auth.service.ts` signs:

- Access token: 1 hour
- Refresh token: 7 days

The signed payload includes `sub`, `email`, `name`, and `organizationId` when the user has an organization membership. Analyzer persistence depends on `organizationId` being present.

Both tokens are currently returned in the JSON response body. The active controller does not set httpOnly cookies, rotate refresh tokens, revoke refresh tokens, or expose a refresh endpoint.

JWT-protected routes should use `JwtAuthGuard` and expect bearer tokens:

```http
Authorization: Bearer <accessToken>
```

## Configuration

The active Nest module reads:

```env
JWT_SECRET=your-secret-key
```

If `JWT_SECRET` is not configured, the module falls back to `your-secret-key`. That fallback is acceptable only for local development and must not be used for production.

## Client Example

```typescript
const loginResponse = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const { accessToken, user } = await loginResponse.json();

const protectedResponse = await fetch('/api/workspaces', {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});
```

## Implemented Security Controls

- DTO validation through Nest validation pipes.
- bcrypt password hashing.
- JWT bearer authentication.
- Helmet and CORS configured in `main.ts`.
- Cookie parser is installed globally, but auth tokens are not currently issued as cookies.

## Not Yet Implemented

These are planned or partially scaffolded, but not active product behavior:

- Refresh endpoint and refresh-token rotation.
- Logout and logout-all endpoints.
- OAuth provider routes.
- Email verification.
- Forgot-password and reset-password flow.
- API key management.
- Auth rate limiting.
- CSRF protection.
- Session management UI.
- Two-factor authentication.
- Audit logging.

## Database Entities Used

The active auth service uses:

- `User`
- `Organization`
- `Membership`

Refresh-token and OAuth-account persistence are not part of the current active Nest auth flow.

## Tests

Run backend tests from the backend package:

```bash
cd packages/analyzer-core
npm run test -- auth
```

If no auth-specific tests are discovered, add tests before relying on auth behavior for production gates.
