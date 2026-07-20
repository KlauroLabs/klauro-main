// Route guard: unauthenticated -> auth routes only. Replaces the old
// monolithic main.tsx's "if (!token) return <AuthModal/>" early-return with
// a real router-level gate (LANE-COMMON: "the gate is a route guard now, not
// an if in a monolith").
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { LoadingState } from '../layout/LoadingState';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { token, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingState label="Signing you in…" />;
  }
  if (!token) {
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}
