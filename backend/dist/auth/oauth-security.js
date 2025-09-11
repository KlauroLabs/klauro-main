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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OAuthSecurity = void 0;
const crypto = __importStar(require("crypto"));
class OAuthSecurity {
    static generateState() {
        return crypto.randomBytes(32).toString('base64url');
    }
    static generatePKCE() {
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto
            .createHash('sha256')
            .update(codeVerifier)
            .digest('base64url');
        return { codeVerifier, codeChallenge };
    }
    static createOAuthSession(provider, returnUrl, usePKCE = true) {
        const state = this.generateState();
        const pkce = usePKCE ? this.generatePKCE() : undefined;
        const oauthState = {
            state,
            codeVerifier: pkce?.codeVerifier,
            codeChallenge: pkce?.codeChallenge,
            createdAt: Date.now(),
            returnUrl,
            provider,
        };
        this.stateStore.set(state, oauthState);
        return {
            state,
            codeChallenge: pkce?.codeChallenge,
        };
    }
    static validateState(state, provider) {
        const stored = this.stateStore.get(state);
        if (!stored) {
            return null;
        }
        if (stored.provider !== provider) {
            return null;
        }
        const now = Date.now();
        if (now - stored.createdAt > this.STATE_TTL) {
            this.stateStore.delete(state);
            return null;
        }
        this.stateStore.delete(state);
        return stored;
    }
    static getCodeVerifier(state) {
        const stored = this.stateStore.get(state);
        return stored?.codeVerifier;
    }
    static validatePKCE(codeVerifier, codeChallenge) {
        const computedChallenge = crypto
            .createHash('sha256')
            .update(codeVerifier)
            .digest('base64url');
        return computedChallenge === codeChallenge;
    }
    static middleware() {
        return (req, res, next) => {
            const { state, code } = req.query;
            if (!state || typeof state !== 'string') {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: 'Missing or invalid OAuth state parameter',
                });
            }
            if (!code || typeof code !== 'string') {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: 'Missing or invalid OAuth authorization code',
                });
            }
            const provider = req.path.split('/')[3];
            const storedState = this.validateState(state, provider);
            if (!storedState) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Invalid or expired OAuth state',
                });
            }
            req.oauthState = storedState;
            next();
        };
    }
}
exports.OAuthSecurity = OAuthSecurity;
_a = OAuthSecurity;
OAuthSecurity.stateStore = new Map();
OAuthSecurity.STATE_TTL = 10 * 60 * 1000;
(() => {
    setInterval(() => {
        const now = Date.now();
        for (const [key, value] of _a.stateStore.entries()) {
            if (now - value.createdAt > _a.STATE_TTL) {
                _a.stateStore.delete(key);
            }
        }
    }, 60 * 1000);
})();
