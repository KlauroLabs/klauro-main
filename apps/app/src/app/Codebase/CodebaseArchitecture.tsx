import { Box, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { LoadingState } from '@/shared/layout/LoadingState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { useProjectSummary } from '@/shared/hooks/useProjectSummary';
import { useSubCasNodeIndex } from '@/shared/hooks/useSubCasNodes';
import { useArchitectureConcepts } from '@/shared/hooks/useArchitectureConcepts';
import { asExtendedSummary } from './casSummary';
import { ArchitectureDiagram } from '@/app/Codebase/sections/ArchitectureDiagram';

export function CodebaseArchitecture() {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const summaryQuery = useProjectSummary(projectId);
  const subCasNodeIndex = useSubCasNodeIndex(projectId);
  const concepts = useArchitectureConcepts(projectId);

  if (!projectId) return null;
  if (summaryQuery.isLoading) return <LoadingState label="Loading architecture…" />;
  if (summaryQuery.isError) return <ErrorState message="Could not load architecture for this codebase." />;
  if (!summaryQuery.data?.summary) {
    return <EmptyState title="No analysis yet" description="Architecture details appear once this codebase has been analyzed." />;
  }

  const summary = asExtendedSummary(summaryQuery.data.summary)!;
  const patterns = summary.architectural_patterns ?? summary.architecture_summary?.architectural_patterns ?? [];
  const inventory = summary.architectural_inventory_counts ?? {};
  const inventoryEntries = Object.entries(inventory).filter(([, count]) => count > 0);
  const balance = summary.pattern_balance ?? summary.architecture_summary?.pattern_balance ?? undefined;

  return (
    <Stack spacing={4}>
      <Paper variant="outlined" sx={{ p: 4 }}>
        <Typography variant="caption" color="text.disabled">System type</Typography>
        <Typography variant="h3" sx={{ mt: 0.5 }}>{summary.architecture_type || 'Not yet determined'}</Typography>
      </Paper>

      <Box>
        <Typography variant="subtitle1" sx={{ mb: 2 }}>Architecture diagram</Typography>
        <ArchitectureDiagram
          projectId={projectId}
          evidence={subCasNodeIndex.evidence}
          conceptInventory={concepts.inventory}
          conceptEdges={concepts.edges}
        />
      </Box>

      <Box>
        <Typography variant="subtitle1" sx={{ mb: 2 }}>Detected patterns</Typography>
        {patterns.length === 0 ? (
          <Typography variant="body2" color="text.secondary">No architectural patterns were detected.</Typography>
        ) : (
          <Stack spacing={1.5}>
            {patterns.map(pattern => (
              <Paper key={pattern.name} variant="outlined" sx={{ p: 2.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <Typography variant="body2">{pattern.name}</Typography>
                  {pattern.category ? <Chip size="small" label={pattern.category} /> : null}
                </Stack>
                {typeof pattern.confidence === 'number' ? (
                  <Typography variant="caption" color="text.disabled">{Math.round(pattern.confidence * 100)}% confidence</Typography>
                ) : null}
              </Paper>
            ))}
          </Stack>
        )}
      </Box>

      {inventoryEntries.length > 0 ? (
        <Box>
          <Typography variant="subtitle1" sx={{ mb: 2 }}>Architectural inventory</Typography>
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
            {inventoryEntries.map(([kind, count]) => (
              <Paper key={kind} variant="outlined" sx={{ p: 2, width: 180 }}>
                <Typography variant="caption" color="text.disabled">{kind}</Typography>
                <Typography variant="h3">{count}</Typography>
              </Paper>
            ))}
          </Stack>
        </Box>
      ) : null}

      {balance ? (
        <Box>
          <Typography variant="subtitle1" sx={{ mb: 2 }}>Pattern balance</Typography>
          <Stack spacing={1.5}>
            {Object.entries(balance).map(([label, ratio]) => (
              <Box key={label}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 0.5 }}>
                  <Typography variant="caption">{label}</Typography>
                  <Typography variant="caption" color="text.disabled">{Math.round((ratio as number) * 100)}%</Typography>
                </Stack>
                <LinearProgress variant="determinate" value={Math.min(100, (ratio as number) * 100)} />
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Stack>
  );
}
