import { Box, Chip, Stack, Typography } from '@mui/material';
import type { EntryPoint } from '@/shared/hooks/useEntryPoints';
import { securityLabel } from '@/app/EntryPoints/formatEntryPoint';

export function SecurityCard({ entryPoint }: { entryPoint: EntryPoint }) {
  const { label, open } = securityLabel(entryPoint);
  const sec = entryPoint.security;
  const roles = sec?.authorized_roles ?? sec?.roles ?? [];

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Security
      </Typography>
      <Chip
        size="small"
        color={open ? 'default' : 'success'}
        variant="outlined"
        label={label}
        sx={{ mb: open ? 0 : 1.5 }}
      />
      {!open && (sec?.enforcement || roles.length || sec?.permissions?.length || sec?.rate_limit) ? (
        <Stack spacing={0.75} sx={{ mt: 1 }}>
          {sec?.enforcement ? (
            <Typography variant="caption" color="text.secondary">
              Enforcement: {sec.enforcement === 'enforced' ? 'enforced' : 'assumed (no matching enforcement point found)'}
            </Typography>
          ) : null}
          {roles.length ? (
            <Typography variant="caption" color="text.secondary">
              Role{roles.length > 1 ? 's' : ''}: {roles.join(', ')}
            </Typography>
          ) : null}
          {sec?.permissions?.length ? (
            <Typography variant="caption" color="text.secondary">
              Must have: {sec.permissions.join(', ')}
            </Typography>
          ) : null}
          {sec?.rate_limit ? (
            <Typography variant="caption" color="text.secondary">
              Limit: {sec.rate_limit}
            </Typography>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}
