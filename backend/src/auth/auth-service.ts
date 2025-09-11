import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { UserRepository } from '../database/repositories/user-repository';
import { OrganizationRepository } from '../database/repositories/organization-repository';
import { 
  User, 
  AuthRequest, 
  RegisterRequest, 
  AuthResponse, 
  JWTPayload,
  RefreshToken,
  OAuthProfile
} from '../types';
import { authConfig } from '../config/auth.config';

export class AuthService {
  private userRepo: UserRepository;
  private orgRepo: OrganizationRepository;

  constructor(private pool: Pool) {
    this.userRepo = new UserRepository(pool);
    this.orgRepo = new OrganizationRepository(pool);
  }

  async register(data: RegisterRequest): Promise<AuthResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user already exists
      const existingUser = await this.userRepo.findByEmail(data.email);
      if (existingUser) {
        throw new Error('User with this email already exists');
      }

      // Validate password strength
      this.validatePassword(data.password);

      // Hash password
      const passwordHash = await bcrypt.hash(data.password, authConfig.security.bcryptRounds);

      // Create user
      const user = await this.userRepo.createUser({
        email: data.email,
        password_hash: passwordHash,
        first_name: data.first_name,
        last_name: data.last_name,
      });

      // Create organization if provided
      let organization = null;
      if (data.organization_name) {
        const slug = this.generateSlug(data.organization_name);
        organization = await this.orgRepo.create({
          name: data.organization_name,
          slug,
          billing_email: data.email,
        });

        // Add user as owner of the organization
        await this.userRepo.createMembership({
          user_id: user.id,
          organization_id: organization.id,
          role: 'owner',
        });
      }

      await client.query('COMMIT');

      // Generate tokens
      const tokens = await this.generateTokens(user);

      return {
        ...tokens,
        user,
        organizations: organization ? [organization] : [],
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async login(data: AuthRequest): Promise<AuthResponse> {
    // Find user by email
    const user = await this.userRepo.findByEmail(data.email);
    if (!user) {
      throw new Error('Invalid email or password');
    }

    // Verify password
    if (!user.password_hash) {
      throw new Error('Please use OAuth to login');
    }

    const isValidPassword = await bcrypt.compare(data.password, user.password_hash);
    if (!isValidPassword) {
      throw new Error('Invalid email or password');
    }

    // Update last login
    await this.userRepo.updateLastLogin(user.id);

    // Get user organizations
    const organizations = await this.userRepo.getUserOrganizations(user.id);

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      ...tokens,
      user,
      organizations,
    };
  }

  async loginWithOAuth(profile: OAuthProfile): Promise<AuthResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check if OAuth account exists
      const oauthQuery = `
        SELECT user_id FROM oauth_accounts 
        WHERE provider = $1 AND provider_user_id = $2
      `;
      const oauthResult = await client.query(oauthQuery, [profile.provider, profile.id]);

      let user: User;

      if (oauthResult.rows.length > 0) {
        // User exists, fetch user data
        user = await this.userRepo.findById(oauthResult.rows[0].user_id);
        if (!user) {
          throw new Error('User account not found');
        }
      } else {
        // Check if user exists with this email
        user = await this.userRepo.findByEmail(profile.email) as User;
        
        if (!user) {
          // Create new user
          user = await this.userRepo.createUser({
            email: profile.email,
            first_name: profile.first_name,
            last_name: profile.last_name,
            avatar_url: profile.avatar_url,
          });
        }

        // Link OAuth account
        const linkQuery = `
          INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, profile)
          VALUES ($1, $2, $3, $4, $5)
        `;
        await client.query(linkQuery, [
          uuidv4(),
          user.id,
          profile.provider,
          profile.id,
          JSON.stringify(profile),
        ]);
      }

      await client.query('COMMIT');

      // Update last login
      await this.userRepo.updateLastLogin(user.id);

      // Get user organizations
      const organizations = await this.userRepo.getUserOrganizations(user.id);

      // Generate tokens
      const tokens = await this.generateTokens(user);

      return {
        ...tokens,
        user,
        organizations,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshToken(refreshToken: string): Promise<AuthResponse> {
    // Verify refresh token
    let payload: JWTPayload;
    try {
      payload = jwt.verify(refreshToken, authConfig.jwt.refreshSecret, {
        issuer: authConfig.jwt.issuer,
        audience: authConfig.jwt.audience,
      }) as JWTPayload;
    } catch (error) {
      throw new Error('Invalid refresh token');
    }

    // Check if token exists and is not revoked
    const tokenRecord = await this.userRepo.findRefreshToken(refreshToken);
    if (!tokenRecord) {
      throw new Error('Refresh token not found or expired');
    }

    // Get user
    const user = await this.userRepo.findById(payload.sub);
    if (!user) {
      throw new Error('User not found');
    }

    // Revoke old refresh token
    await this.userRepo.revokeRefreshToken(refreshToken);

    // Get user organizations
    const organizations = await this.userRepo.getUserOrganizations(user.id);

    // Generate new tokens
    const tokens = await this.generateTokens(user);

    return {
      ...tokens,
      user,
      organizations,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.userRepo.revokeRefreshToken(refreshToken);
  }

  async logoutAllDevices(userId: string): Promise<void> {
    await this.userRepo.revokeAllUserTokens(userId);
  }

  async verifyAccessToken(token: string): Promise<JWTPayload> {
    try {
      const payload = jwt.verify(token, authConfig.jwt.accessSecret, {
        issuer: authConfig.jwt.issuer,
        audience: authConfig.jwt.audience,
      }) as JWTPayload;

      if (payload.type !== 'access') {
        throw new Error('Invalid token type');
      }

      return payload;
    } catch (error) {
      throw new Error('Invalid access token');
    }
  }

  async getUserWithMemberships(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const memberships = await this.userRepo.getUserMemberships(userId);
    return { user, memberships };
  }

  private async generateTokens(user: User): Promise<{ access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number }> {
    // Get user memberships for token payload
    const memberships = await this.userRepo.getUserMemberships(user.id);
    
    const organizations = memberships.map(m => ({
      id: m.organization_id,
      role: m.role,
    }));

    // Generate access token
    const accessPayload: JWTPayload = {
      sub: user.id,
      email: user.email,
      organizations,
      type: 'access',
    };

    const accessToken = jwt.sign(accessPayload, authConfig.jwt.accessSecret, {
      expiresIn: authConfig.jwt.accessExpiresIn,
      issuer: authConfig.jwt.issuer,
      audience: authConfig.jwt.audience,
    });

    // Generate refresh token
    const refreshPayload: JWTPayload = {
      sub: user.id,
      email: user.email,
      type: 'refresh',
    };

    const refreshToken = jwt.sign(refreshPayload, authConfig.jwt.refreshSecret, {
      expiresIn: authConfig.jwt.refreshExpiresIn,
      issuer: authConfig.jwt.issuer,
      audience: authConfig.jwt.audience,
    });

    // Calculate expiration time
    const expiresIn = this.parseExpiresIn(authConfig.jwt.accessExpiresIn);
    const refreshExpiresAt = new Date(Date.now() + this.parseExpiresIn(authConfig.jwt.refreshExpiresIn) * 1000);

    // Save refresh token to database
    await this.userRepo.saveRefreshToken(user.id, refreshToken, refreshExpiresAt);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }

  private validatePassword(password: string): void {
    const config = authConfig.security;

    if (password.length < config.passwordMinLength) {
      throw new Error(`Password must be at least ${config.passwordMinLength} characters long`);
    }

    if (config.passwordRequireUppercase && !/[A-Z]/.test(password)) {
      throw new Error('Password must contain at least one uppercase letter');
    }

    if (config.passwordRequireLowercase && !/[a-z]/.test(password)) {
      throw new Error('Password must contain at least one lowercase letter');
    }

    if (config.passwordRequireNumbers && !/\d/.test(password)) {
      throw new Error('Password must contain at least one number');
    }

    if (config.passwordRequireSpecial && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      throw new Error('Password must contain at least one special character');
    }
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 100);
  }

  private parseExpiresIn(expiresIn: string): number {
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) {
      return 900; // Default to 15 minutes
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: return 900;
    }
  }
}