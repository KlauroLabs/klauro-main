import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { PageHeader } from '../../layout/PageHeader';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { useEntryPointsForDeployable } from '../../hooks/useEntryPoints';
import { DeployableSwitcher } from './DeployableSwitcher';
import { FamilyMixSummary } from './FamilyMixSummary';
import { KindFilterChips } from './KindFilterChips';
import { EntryPointTable } from './EntryPointTable';
import { formatTrigger } from './formatEntryPoint';
import type { EntryKind } from '../../components/entryPointKinds';

/**
 * Entry points, per deployable — route /codebases/:projectId/entry-points.
 * Binding structure (brief + LANE-COMMON.md): PER-DEPLOYABLE with a
 * switcher, never a flat repo-wide list; family mix shown before the table.
 * Derived layout — see apps/app/docs/DESIGN-NOTES.md (no Figma screen for
 * this route; mirrors the Flow List screen's catalog pattern).
 */
export function EntryPointsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [deployableId, setDeployableId] = useState<string | undefined>(undefined);
  const [kindFilter, setKindFilter] = useState<EntryKind | null>(null);
  const [search, setSearch] = useState('');

  const query = useEntryPointsForDeployable(projectId, deployableId);

  const filtered = useMemo(() => {
    let rows = query.entryPoints;
    if (kindFilter) rows = rows.filter(ep => ep.type === kindFilter);
    const term = search.trim().toLowerCase();
    if (term) {
      rows = rows.filter(ep => {
        const trigger = formatTrigger(ep) ?? '';
        return ep.name.toLowerCase().includes(term) || trigger.toLowerCase().includes(term);
      });
    }
    return rows;
  }, [query.entryPoints, kindFilter, search]);

  if (!projectId) return null;
  if (query.isLoading) return <LoadingState label="Loading entry points…" />;
  if (query.isError) return <ErrorState message="Could not load entry points for this codebase." />;

  if (query.allEntryPoints.length === 0) {
    return (
      <EmptyState
        title="No entry points found"
        description="This codebase's analysis found no ways in — a real, common case for a pure library or a still-analyzing repository."
      />
    );
  }

  return (
    <Box>
      <PageHeader
        title="Entry Points"
        subtitle="Every way something outside this deployable can reach in and make it do work."
        actions={
          <DeployableSwitcher deployables={query.deployables} value={deployableId} onChange={setDeployableId} />
        }
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <FamilyMixSummary familyCounts={query.familyCounts} />

        <TextField
          size="small"
          placeholder="Search by name or address…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
          sx={{ maxWidth: 480 }}
        />

        <KindFilterChips familyCounts={query.familyCounts} selected={kindFilter} onSelect={setKindFilter} />

        {filtered.length === 0 && query.entryPoints.length > 0 ? (
          <Typography variant="body2" color="text.secondary">
            No entry points match "{search}"{kindFilter ? ' with this kind selected' : ''}.
          </Typography>
        ) : (
          <EntryPointTable entryPoints={filtered} projectId={projectId} />
        )}
      </Stack>
    </Box>
  );
}
