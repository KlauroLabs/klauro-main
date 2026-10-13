import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Paper, Stack, TextField, Typography, Alert, CircularProgress } from '@mui/material';
import { useAuth } from '@/shared/auth/AuthProvider';
import { approveDeviceCode, denyDeviceCode, getDeviceCodeStatus } from '@/shared/api/index';
import { Logo } from '@/shared/components/Logo';

type Outcome = 'idle' | 'approved' | 'denied';

interface Preview {
  clientName: string;
  requestedAt: Date;
}

export function DevicePage() {
  const { token, user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [userCode, setUserCode] = useState(searchParams.get('code') || '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>('idle');

  useEffect(() => {
    const code = userCode.trim();
    setPreview(null);
    setLookupError('');
    if (code.length < 8) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const handle = setTimeout(() => {
      getDeviceCodeStatus(code)
        .then((result) => {
          if (!cancelled) setPreview({ clientName: result.client_name, requestedAt: new Date(result.requested_at) });
        })
        .catch(() => {
          if (!cancelled) setLookupError('That code is unknown or has expired. Check it and try again.');
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [userCode]);

  async function approve() {
    if (!token || !userCode.trim() || !preview) return;
    setError('');
    setBusy(true);
    try {
      await approveDeviceCode(userCode, token);
      setOutcome('approved');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (!token || !userCode.trim()) return;
    setError('');
    setBusy(true);
    try {
      await denyDeviceCode(userCode, token);
      setOutcome('denied');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!loading && !token) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', p: 2 }}>
        <Paper sx={{ p: 4, width: '100%', maxWidth: 420 }}>
          <Stack spacing={3}>
            <Logo variant="lockup" size={22} />
            <Typography variant="body1">Sign in to approve this device.</Typography>
            <Button
              variant="contained"
              size="large"
              onClick={() => navigate('/auth', { state: { from: location } })}
            >
              Sign in
            </Button>
          </Stack>
        </Paper>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', p: 2 }}>
      <Paper sx={{ p: 4, width: '100%', maxWidth: 420 }}>
        <Stack spacing={3}>
          <Stack spacing={0.5}>
            <Logo variant="lockup" size={22} />
            <Typography variant="h3" component="h1">
              Sign in to a device
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {user ? `Signed in as ${user.email}.` : ''} Only approve this if you just started signing in on another device yourself.
            </Typography>
          </Stack>

          {outcome === 'approved' && <Alert severity="success">Device approved — you can return to it now.</Alert>}
          {outcome === 'denied' && <Alert severity="info">Sign-in request denied.</Alert>}

          {outcome === 'idle' && (
            <Stack spacing={2}>
              <TextField
                label="Device code"
                value={userCode}
                onChange={(event) => setUserCode(event.target.value)}
                placeholder="XXXX-XXXX"
                autoFocus
                fullWidth
              />

              {checking && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="text.secondary">Looking up that code…</Typography>
                </Stack>
              )}
              {!checking && preview && (
                <Alert severity="warning">
                  <strong>{preview.clientName}</strong> wants to sign in to your Klauro account — requested at {preview.requestedAt.toLocaleTimeString()}. Only approve this if you recognize it as something you just did yourself.
                </Alert>
              )}
              {!checking && lookupError && <Alert severity="error">{lookupError}</Alert>}
              {error && <Alert severity="error">{error}</Alert>}

              <Stack direction="row" spacing={1}>
                <Button variant="contained" size="large" disabled={busy || !preview} onClick={() => void approve()} fullWidth>
                  Approve
                </Button>
                <Button variant="outlined" size="large" disabled={busy || !userCode.trim()} onClick={() => void deny()} fullWidth>
                  Deny
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
