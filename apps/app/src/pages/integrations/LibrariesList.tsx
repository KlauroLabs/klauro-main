import { useState } from 'react';
import { List, ListItem, ListItemText, Typography, Chip, Stack, ToggleButtonGroup, ToggleButton, Box } from '@mui/material';
import type { Library, DependencyManifest } from '../../hooks/useLibraries';

const TYPE_LABEL: Record<NonNullable<Library['type']>, string> = {
  production: 'Runtime',
  development: 'Development',
  peer: 'Peer',
  optional: 'Optional',
};

/**
 * Libraries — manifest facts about what the codebase depends on. Two views
 * toggle over the same underlying facts (see useLibraries.ts's doc comment
 * for why they're kept separate rather than merged into one array):
 * "Recognized" is the subset the analyzer's library detectors interpreted
 * (usage patterns, criticality); "All declared" is the complete raw
 * dependency_manifest — every name in every package.json, whether or not a
 * detector understood it. Runtime vs Development is the closest evidence-
 * backed split the data model carries (CASLibrary.type / declared scope) —
 * see the design brief for why this page doesn't claim an internal/external
 * distinction the data doesn't have.
 */
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
