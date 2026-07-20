// Bootstrap only — real routing/pages live in router.tsx + src/pages/**.
// The old monolithic main.tsx (Sidebar/Topbar/HomeView/WorkspaceView/
// RepoOverview/modals, ~1300 lines) has been superseded: sidebar+topbar are
// now AppShell (src/layout/), the auth form is now src/pages/auth/AuthPage.tsx,
// and every other view is a routed page component owned by its page lane.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { theme } from './theme';
import { queryClient } from './hooks/queryClient';
import { AuthProvider } from './auth/AuthProvider';
import { router } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
