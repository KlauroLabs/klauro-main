"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const jwt = __importStar(require("jsonwebtoken"));
const bcrypt = __importStar(require("bcrypt"));
const uuid_1 = require("uuid");
const user_repository_1 = require("../database/repositories/user-repository");
const organization_repository_1 = require("../database/repositories/organization-repository");
const auth_config_1 = require("../config/auth.config");
class AuthService {
    constructor(pool) {
        this.pool = pool;
        this.userRepo = new user_repository_1.UserRepository(pool);
        this.orgRepo = new organization_repository_1.OrganizationRepository(pool);
    }
    async register(data) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const existingUser = await this.userRepo.findByEmail(data.email);
            if (existingUser) {
                throw new Error('User with this email already exists');
            }
            this.validatePassword(data.password);
            const passwordHash = await bcrypt.hash(data.password, auth_config_1.authConfig.security.bcryptRounds);
            const user = await this.userRepo.createUser({
                email: data.email,
                password_hash: passwordHash,
                first_name: data.first_name,
                last_name: data.last_name,
            });
            let organization = null;
            if (data.organization_name) {
                const slug = this.generateSlug(data.organization_name);
                organization = await this.orgRepo.create({
                    name: data.organization_name,
                    slug,
                    billing_email: data.email,
                    settings: {},
                });
                await this.userRepo.createMembership({
                    user_id: user.id,
                    organization_id: organization.id,
                    role: 'owner',
                });
            }
            await client.query('COMMIT');
            const tokens = await this.generateTokens(user);
            return {
                ...tokens,
                user,
                organizations: organization ? [organization] : [],
            };
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async login(data) {
        const user = await this.userRepo.findByEmail(data.email);
        if (!user) {
            throw new Error('Invalid email or password');
        }
        if (!user.password_hash) {
            throw new Error('Please use OAuth to login');
        }
        const isValidPassword = await bcrypt.compare(data.password, user.password_hash);
        if (!isValidPassword) {
            throw new Error('Invalid email or password');
        }
        await this.userRepo.updateLastLogin(user.id);
        const organizations = await this.userRepo.getUserOrganizations(user.id);
        const tokens = await this.generateTokens(user);
        return {
            ...tokens,
            user,
            organizations,
        };
    }
    async loginWithOAuth(profile) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const oauthQuery = `
        SELECT user_id FROM oauth_accounts 
        WHERE provider = $1 AND provider_user_id = $2
      `;
            const oauthResult = await client.query(oauthQuery, [profile.provider, profile.id]);
            let user;
            if (oauthResult.rows.length > 0) {
                const foundUser = await this.userRepo.findById(oauthResult.rows[0].user_id);
                if (!foundUser) {
                    throw new Error('User account not found');
                }
                user = foundUser;
            }
            else {
                user = await this.userRepo.findByEmail(profile.email);
                if (!user) {
                    user = await this.userRepo.createUser({
                        email: profile.email,
                        first_name: profile.first_name,
                        last_name: profile.last_name,
                        avatar_url: profile.avatar_url,
                    });
                }
                const linkQuery = `
          INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, profile)
          VALUES ($1, $2, $3, $4, $5)
        `;
                await client.query(linkQuery, [
                    (0, uuid_1.v4)(),
                    user.id,
                    profile.provider,
                    profile.id,
                    JSON.stringify(profile),
                ]);
            }
            await client.query('COMMIT');
            await this.userRepo.updateLastLogin(user.id);
            const organizations = await this.userRepo.getUserOrganizations(user.id);
            const tokens = await this.generateTokens(user);
            return {
                ...tokens,
                user,
                organizations,
            };
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async refreshToken(refreshToken) {
        let payload;
        try {
            payload = jwt.verify(refreshToken, auth_config_1.authConfig.jwt.refreshSecret, {
                issuer: auth_config_1.authConfig.jwt.issuer,
                audience: auth_config_1.authConfig.jwt.audience,
            });
        }
        catch (error) {
            throw new Error('Invalid refresh token');
        }
        const tokenRecord = await this.userRepo.findRefreshToken(refreshToken);
        if (!tokenRecord) {
            throw new Error('Refresh token not found or expired');
        }
        const user = await this.userRepo.findById(payload.sub);
        if (!user) {
            throw new Error('User not found');
        }
        await this.userRepo.revokeRefreshToken(refreshToken);
        const organizations = await this.userRepo.getUserOrganizations(user.id);
        const tokens = await this.generateTokens(user);
        return {
            ...tokens,
            user,
            organizations,
        };
    }
    async logout(refreshToken) {
        await this.userRepo.revokeRefreshToken(refreshToken);
    }
    async logoutAllDevices(userId) {
        await this.userRepo.revokeAllUserTokens(userId);
    }
    async verifyAccessToken(token) {
        try {
            const payload = jwt.verify(token, auth_config_1.authConfig.jwt.accessSecret, {
                issuer: auth_config_1.authConfig.jwt.issuer,
                audience: auth_config_1.authConfig.jwt.audience,
            });
            if (payload.type !== 'access') {
                throw new Error('Invalid token type');
            }
            return payload;
        }
        catch (error) {
            throw new Error('Invalid access token');
        }
    }
    async getUserWithMemberships(userId) {
        const user = await this.userRepo.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        const memberships = await this.userRepo.getUserMemberships(userId);
        return { user, memberships };
    }
    async generateTokens(user) {
        const memberships = await this.userRepo.getUserMemberships(user.id);
        const organizations = memberships.map(m => ({
            id: m.organization_id,
            role: m.role,
        }));
        const accessPayload = {
            sub: user.id,
            email: user.email,
            organizations,
            type: 'access',
        };
        const accessToken = jwt.sign(accessPayload, auth_config_1.authConfig.jwt.accessSecret, {
            expiresIn: auth_config_1.authConfig.jwt.accessExpiresIn,
            issuer: auth_config_1.authConfig.jwt.issuer,
            audience: auth_config_1.authConfig.jwt.audience,
        });
        const refreshPayload = {
            sub: user.id,
            email: user.email,
            type: 'refresh',
        };
        const refreshToken = jwt.sign(refreshPayload, auth_config_1.authConfig.jwt.refreshSecret, {
            expiresIn: auth_config_1.authConfig.jwt.refreshExpiresIn,
            issuer: auth_config_1.authConfig.jwt.issuer,
            audience: auth_config_1.authConfig.jwt.audience,
        });
        const expiresIn = this.parseExpiresIn(auth_config_1.authConfig.jwt.accessExpiresIn);
        const refreshExpiresAt = new Date(Date.now() + this.parseExpiresIn(auth_config_1.authConfig.jwt.refreshExpiresIn) * 1000);
        await this.userRepo.saveRefreshToken(user.id, refreshToken, refreshExpiresAt);
        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
        };
    }
    validatePassword(password) {
        const config = auth_config_1.authConfig.security;
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
    generateSlug(name) {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 100);
    }
    parseExpiresIn(expiresIn) {
        const match = expiresIn.match(/^(\d+)([smhd])$/);
        if (!match) {
            return 900;
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
exports.AuthService = AuthService;
