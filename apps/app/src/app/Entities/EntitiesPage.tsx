import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, InputAdornment, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useDataEntities } from '@/shared/hooks/useEntities';
import { EntityTable } from './EntityTable';
import { ERDCanvas } from '@/shared/components/entities/ERDCanvas';

export function EntitiesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'table' | 'diagram'>('table');

  const query = useDataEntities(projectId);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return query.entities;
    return query.entities.filter(e => e.name.toLowerCase().includes(term) || (e.schema_source ?? '').toLowerCase().includes(term));
  }, [query.entities, search]);

  if (!projectId) return null;
  if (query.isLoading) return <LoadingState label="Loading entities…" />;
  if (query.isError) return <ErrorState message="Could not load entities for this codebase." />;

  if (query.entities.length === 0) {
    return (
      <EmptyState
        title="No data entities found"
        description="This codebase's analysis found no ORM entities, request DTOs, API response shapes, or value objects — a real case for a repo with no database, or one still analyzing."
      />
    );
  }

  return (
    <Box>
      <PageHeader
        title="Entities"
        subtitle="The important objects this codebase reads, writes, and passes across boundaries — with their relationships to each other."
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            placeholder="Search by name or source file…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
            sx={{ maxWidth: 480, flexGrow: 1 }}
          />
          <ToggleButtonGroup size="small" value={view} exclusive onChange={(_e, next) => next && setView(next)}>
            <ToggleButton value="table">Table</ToggleButton>
            <ToggleButton value="diagram">Diagram</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {filtered.length === 0 && query.entities.length > 0 ? (
          <Typography variant="body2" color="text.secondary">
            No entities match "{search}".
          </Typography>
        ) : view === 'table' ? (
          <EntityTable entities={filtered} projectId={projectId} />
        ) : (
          <ERDCanvas projectId={projectId} entities={filtered} databaseEntityByNameLower={query.databaseEntityByNameLower} />
        )}
      </Stack>
    </Box>
  );
}
