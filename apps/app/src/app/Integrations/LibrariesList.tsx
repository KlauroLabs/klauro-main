import { useState } from 'react';
import { List, ListItem, ListItemText, Typography, Chip, Stack, ToggleButtonGroup, ToggleButton, Box } from '@mui/material';
import type { Library, DependencyManifest } from '@/shared/hooks/useLibraries';

const TYPE_LABEL: Record<NonNullable<Library['type']>, string> = {
  production: 'Runtime',
  development: 'Development',
  peer: 'Peer',
  optional: 'Optional',
};

export function LibrariesList({ libraries, dependencyManifest }: { libraries: Library[]; dependencyManifest?: DependencyManifest }) {
  const [view, setView] = useState<'recognized' | 'declared'>('recognized');
  const hasManifest = Boolean(dependencyManifest?.dependencies.length);

  if (libraries.length === 0 && !hasManifest) {
    return (
      <Typography variant="body2" color="text.secondary">
        No dependency manifest found — a real case for a project with no package.json/requirements.txt-style
        manifest at all.
      </Typography>
    );
  }

  return (
    <Box>
      {hasManifest ? (
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_e, next) => next && setView(next)} sx={{ mb: 2 }}>
          <ToggleButton value="recognized">Recognized ({libraries.length})</ToggleButton>
          <ToggleButton value="declared">All declared ({dependencyManifest?.total ?? 0})</ToggleButton>
        </ToggleButtonGroup>
      ) : null}

      {view === 'recognized' || !hasManifest ? (
        <List dense disablePadding>
          {libraries.map(lib => (
            <ListItem key={lib.id} disableGutters sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
              <ListItemText
                primary={`${lib.name}${lib.version ? ` — ${lib.version}` : ''}`}
                secondary={lib.category}
              />
              <Stack direction="row" spacing={1}>
                {lib.type ? <Chip size="small" variant="outlined" label={TYPE_LABEL[lib.type]} /> : null}
                {lib.usage_statistics?.critical_path ? <Chip size="small" color="warning" label="Critical path" /> : null}
              </Stack>
            </ListItem>
          ))}
        </List>
      ) : (
        <List dense disablePadding>
          {dependencyManifest?.dependencies.map(dep => (
            <ListItem key={dep.name} disableGutters sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
              <ListItemText
                primary={`${dep.name}${dep.version ? ` — ${dep.version}` : ''}`}
                secondary={dep.declared_in.join(', ')}
              />
              <Chip size="small" variant="outlined" label={dep.scopes.join(', ')} />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}
