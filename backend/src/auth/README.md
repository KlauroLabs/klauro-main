# Unravl Authentication System

## Overview

The Unravl platform implements a comprehensive authentication and authorization system supporting:
- JWT-based authentication with access/refresh token flow
- OAuth integration with multiple providers (GitHub, Google, Microsoft, GitLab)
- Role-Based Access Control (RBAC) with granular permissions
- Multi-tenant organization management
- API key authentication for programmatic access

## Architecture

### Components

1. **AuthService** (`auth-service.ts`)
   - Handles user registration and login
   - Manages JWT token generation and validation
   - Processes OAuth authentication flows
   - Handles password management and email verification

2. **OAuth Providers** (`oauth-providers/oauth-strategies.ts`)
   - Configures Passport.js strategies for OAuth providers
   - Normalizes OAuth profiles across different providers
   - Manages OAuth account linking

3. **Authentication Middleware** (`middleware/auth-middleware.ts`)
   - JWT token verification
   - Session validation
   - Organization context enforcement
   - Email verification checks

4. **RBAC Middleware** (`middleware/rbac-middleware.ts`)
   - Role-based access control
   - Permission-based authorization
   - Resource ownership verification
   - Team membership validation

## Authentication Flow

### Registration Flow
```
1. User submits registration form
2. Validate input and password strength
3. Hash password with bcrypt
4. Create user account
5. Optional: Create organization with user as owner
6. Generate JWT access and refresh tokens
7. Return tokens and user data
```

### Login Flow
```
1. User submits credentials
2. Validate email and password
3. Update last login timestamp
4. Fetch user organizations
5. Generate JWT tokens with organization roles
6. Return tokens and user data
```

### OAuth Flow
```
1. User initiates OAuth with provider
2. Redirect to provider authorization
3. Provider redirects back with authorization code
4. Exchange code for access token
5. Fetch user profile from provider
6. Create or link user account
7. Generate JWT tokens
8. Redirect to frontend with tokens
```

### Token Refresh Flow
```
1. Client sends refresh token
2. Validate refresh token
3. Check if token exists and not revoked
4. Revoke old refresh token
5. Generate new access and refresh tokens
6. Return new tokens
```

## Role-Based Access Control

### Roles

- **Owner**: Full control over organization
- **Admin**: Manage organization, projects, and users
- **Member**: Create and manage projects, limited admin access
- **Viewer**: Read-only access to organization and projects

### Permission Matrix

| Permission | Owner | Admin | Member | Viewer |
|------------|-------|-------|--------|--------|
| org:read | ✅ | ✅ | ✅ | ✅ |
| org:write | ✅ | ✅ | ❌ | ❌ |
| org:delete | ✅ | ❌ | ❌ | ❌ |
| org:billing | ✅ | ❌ | ❌ | ❌ |
| project:create | ✅ | ✅ | ✅ | ❌ |
| project:read | ✅ | ✅ | ✅ | ✅ |
| project:write | ✅ | ✅ | ✅ | ❌ |
| project:delete | ✅ | ✅ | ❌ | ❌ |
| user:invite | ✅ | ✅ | ❌ | ❌ |
| user:remove | ✅ | ✅ | ❌ | ❌ |
| user:update_role | ✅ | ❌ | ❌ | ❌ |

## API Endpoints

### Authentication Endpoints

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/logout` - Logout current session
- `POST /api/auth/logout-all` - Logout all devices
- `POST /api/auth/refresh` - Refresh access token
- `GET /api/auth/me` - Get current user
- `GET /api/auth/oauth/:provider` - Initiate OAuth flow
- `GET /api/auth/oauth/:provider/callback` - OAuth callback
- `POST /api/auth/verify-email` - Verify email address
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/reset-password` - Reset password with token

### Organization Endpoints

- `POST /api/organizations` - Create organization
- `GET /api/organizations` - List user's organizations
- `GET /api/organizations/:id` - Get organization details
- `PUT /api/organizations/:id` - Update organization
- `DELETE /api/organizations/:id` - Delete organization
- `GET /api/organizations/:id/members` - List organization members
- `POST /api/organizations/:id/invite` - Invite user to organization
- `PUT /api/organizations/:id/members/:userId` - Update member role
- `DELETE /api/organizations/:id/members/:userId` - Remove member
- `POST /api/organizations/:id/leave` - Leave organization

### User Endpoints

- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update profile
- `PUT /api/users/settings` - Update settings
- `POST /api/users/change-password` - Change password
- `DELETE /api/users/account` - Delete account
- `GET /api/users/api-keys` - List API keys
- `POST /api/users/api-keys` - Create API key
- `DELETE /api/users/api-keys/:id` - Revoke API key

## Security Features

### Password Security
- Minimum length enforcement (default: 8 characters)
- Character requirements (uppercase, lowercase, numbers, special)
- bcrypt hashing with configurable rounds
- Password strength validation

### Token Security
- Short-lived access tokens (15 minutes)
- Long-lived refresh tokens (7 days)
- Refresh token rotation
- Token revocation support
- Secure httpOnly cookies for refresh tokens

### Rate Limiting
- Authentication endpoints: 5 requests per 15 minutes
- API endpoints: 100 requests per 15 minutes
- Configurable limits per endpoint

### Additional Security
- Helmet.js for security headers
- CORS configuration
- CSRF protection (planned)
- SQL injection prevention
- XSS protection
- Input validation and sanitization

## Configuration

### Environment Variables

```env
# JWT Configuration
JWT_ACCESS_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# OAuth Providers
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-secret

# Security
BCRYPT_ROUNDS=10
PASSWORD_MIN_LENGTH=8
MAX_LOGIN_ATTEMPTS=5
```

## Usage Examples

### Protecting Routes

```typescript
// Require authentication
router.get('/protected', 
  authMiddleware.authenticate, 
  (req, res) => {
    // Access req.userId and req.user
  }
);

// Require organization context
router.get('/org/:organizationId/data',
  authMiddleware.authenticate,
  authMiddleware.requireOrganization,
  rbacMiddleware.requirePermission('org:read'),
  (req, res) => {
    // Access req.organizationId and req.userRole
  }
);

// Require specific role
router.post('/admin-action',
  authMiddleware.authenticate,
  authMiddleware.requireOrganization,
  rbacMiddleware.requireMinRole('admin'),
  (req, res) => {
    // Only admins and owners can access
  }
);
```

### Client Integration

```typescript
// Login
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
  credentials: 'include', // Include cookies
});

const { access_token, user } = await response.json();

// Make authenticated request
const data = await fetch('/api/protected', {
  headers: {
    'Authorization': `Bearer ${access_token}`,
  },
});

// Refresh token
const refreshResponse = await fetch('/api/auth/refresh', {
  method: 'POST',
  credentials: 'include', // Send refresh token cookie
});
```

## Database Schema

### Users Table
- id (UUID, primary key)
- email (unique)
- password_hash
- first_name, last_name
- email_verified_at
- settings (JSONB)

### Organizations Table
- id (UUID, primary key)
- name
- slug (unique)
- settings (JSONB)

### Memberships Table
- user_id (foreign key)
- organization_id (foreign key)
- team_id (optional)
- role (owner|admin|member|viewer)
- permissions (JSONB)

### Refresh Tokens Table
- id (UUID, primary key)
- user_id (foreign key)
- token (unique)
- expires_at
- revoked_at

### OAuth Accounts Table
- user_id (foreign key)
- provider
- provider_user_id
- profile (JSONB)

## Testing

Run authentication tests:
```bash
npm test -- auth
```

## Future Enhancements

- [ ] Two-factor authentication (2FA)
- [ ] Email verification with tokens
- [ ] Password reset email flow
- [ ] Session management UI
- [ ] Audit logging
- [ ] IP-based restrictions
- [ ] Device fingerprinting
- [ ] Biometric authentication support