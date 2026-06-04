import * as crypto from 'crypto';
import { Request, Response } from 'express';

interface OAuthState {
  state: string;
  codeVerifier?: string;
  codeChallenge?: string;
  createdAt: number;
  returnUrl?: string;
  provider: string;
}

interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

export class OAuthSecurity {
  private static stateStore = new Map<string, OAuthState>();
  private static readonly STATE_TTL = 10 * 60 * 1000; // 10 minutes
  
  static {
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.stateStore.entries()) {
        if (now - value.createdAt > this.STATE_TTL) {
          this.stateStore.delete(key);
        }
      }
    }, 60 * 1000); // Cleanup every minute
  }
  
  static generateState(): string {
    return crypto.randomBytes(32).toString('base64url');
  }
  
  static generatePKCE(): PKCEPair {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    
    return { codeVerifier, codeChallenge };
  }
  
  static createOAuthSession(provider: string, returnUrl?: string, usePKCE: boolean = true): {
    state: string;
    codeChallenge?: string;
  } {
    const state = this.generateState();
    const pkce = usePKCE ? this.generatePKCE() : undefined;
    
    const oauthState: OAuthState = {
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
  
  static validateState(state: string, provider: string): OAuthState | null {
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
  
  static getCodeVerifier(state: string): string | undefined {
    const stored = this.stateStore.get(state);
    return stored?.codeVerifier;
  }
  
  static validatePKCE(codeVerifier: string, codeChallenge: string): boolean {
    const computedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    
    return computedChallenge === codeChallenge;
  }
  
  static middleware() {
    return (req: Request, res: Response, next: any) => {
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
      
      (req as any).oauthState = storedState;
      next();
    };
  }
}