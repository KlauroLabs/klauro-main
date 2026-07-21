import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { registerAccount, signIn, apiRequest, type SessionUser } from '@/shared/api/index';

const tokenStorageKey = 'klauro_session_token';

export interface AuthContextValue {
  token: string | null;
  user: SessionUser | null;

  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  registerWithPassword: (input: { email: string; name?: string; password: string; workspace_name?: string }) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(tokenStorageKey));
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(localStorage.getItem(tokenStorageKey)));

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    apiRequest<{ user: SessionUser }>('/api/me', token)
      .then(result => {
        if (cancelled) return;
        setUser(result.user);
      })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem(tokenStorageKey);
        setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const applySession = useCallback((nextToken: string, nextUser: SessionUser) => {
    localStorage.setItem(tokenStorageKey, nextToken);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const session = await signIn(email, password);
    applySession(session.token, session.user);
  }, [applySession]);

  const registerWithPassword = useCallback(async (input: { email: string; name?: string; password: string; workspace_name?: string }) => {
    const session = await registerAccount(input);
    applySession(session.token, session.user);
  }, [applySession]);

  const signOut = useCallback(() => {
    localStorage.removeItem(tokenStorageKey);
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, loading, signInWithPassword, registerWithPassword, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within an AuthProvider');
  return value;
}
