// Extracted from the old main.tsx monolith's AuthModal/AuthForm (see git
// history) into a real route per LANE-COMMON's architecture rule ("the gate
// is a route guard now, not an if in a monolith"). No Figma frame designs
// the auth screen (SCREEN-MAP.md) — derived from the design-language tokens
// only (dark canvas, bordered card, no chrome) since there's no dashboard
// shell to match yet at this point in the flow.
import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Box, Button, Paper, Stack, TextField, Typography, Alert, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useAuth } from '../../auth/AuthProvider';
import { apiBaseUrl } from '../../api';
import { Logo } from '../../components/Logo';

type Mode = 'sign-in' | 'register';

export function AuthPage() {
  const { signInWithPassword, registerWithPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '');
    const password = String(form.get('password') || '');
    try {
      if (mode === 'sign-in') {
        await signInWithPassword(email, password);
      } else {
        await registerWithPassword({
          email,
          password,
          name: String(form.get('name') || '') || undefined,
          workspace_name: String(form.get('workspace_name') || '') || undefined,
        });
      }
      const redirectTo = (location.state as { from?: Location })?.from?.pathname ?? '/';
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Paper sx={{ p: 4, width: '100%', maxWidth: 420 }}>
        <Stack spacing={3}>
          <Stack spacing={0.5}>
            <Logo variant="lockup" size={22} />
            <Typography variant="h3" component="h1">
              {mode === 'sign-in' ? 'Sign in to Klauro' : 'Create your account'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Manage workspaces, projects, hosted analyses, and the context your local MCP uses while you
              work.
            </Typography>
          </Stack>

          <ToggleButtonGroup
            exclusive
            fullWidth
            value={mode}
            onChange={(_event, next) => next && setMode(next)}
            size="small"
          >
            <ToggleButton value="sign-in">Sign in</ToggleButton>
            <ToggleButton value="register">Create account</ToggleButton>
          </ToggleButtonGroup>

          <Stack component="form" spacing={2} onSubmit={handleSubmit}>
            <TextField name="email" type="email" label="Email" required autoComplete="email" fullWidth />
            {mode === 'register' && <TextField name="name" label="Name" autoComplete="name" fullWidth />}
            <TextField
              name="password"
              type="password"
              label="Password"
              required
              slotProps={{ htmlInput: { minLength: 8 } }}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              fullWidth
            />
            {mode === 'register' && (
              <TextField name="workspace_name" label="Workspace" placeholder="Engineering" fullWidth />
            )}
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={submitting}>
              {mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </Button>
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
            API {apiBaseUrl}
          </Typography>
        </Stack>
      </Paper>
    </Box>
  );
}
