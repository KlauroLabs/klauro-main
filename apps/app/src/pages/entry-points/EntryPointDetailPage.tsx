import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Chip, Grid, Stack, Typography } from '@mui/material';
import { PageHeader } from '../../layout/PageHeader';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { EntryKindIcon } from '../../components/EntryKindIcon';
import { KIND_META, isKnownKind } from '../../components/entryPointKinds';
import { useEntryPoint } from '../../hooks/useEntryPoints';
import { useEntryPointFlow } from '../../hooks/useEntryPointFlow';
import { useResolvedProjectId } from '../../hooks/useResolvedProjectId';
import { encodeSlug } from '../../lib/slugs';
import { formatTrigger, looksLikeRawToken, securityLabel } from './formatEntryPoint';
import { SecurityCard } from './sections/SecurityCard';
import { InputCard } from './sections/InputCard';
import { OutputCard } from './sections/OutputCard';
import { HandlerCard } from './sections/HandlerCard';
import { FlowCard } from './sections/FlowCard';
import { CapabilitiesCard } from './sections/CapabilitiesCard';
import { TelemetryCard } from './sections/TelemetryCard';

/**
 * One entry point in full — route
 * /codebases/:projectId/entry-points/:entryPointId. Grain per the brief's
 * "What we know about a single entry point" table: name+description,
 * trigger, security, input, output, the flow it opens, handler file:line,
 * kind+source. Derived layout — see apps/app/docs/DESIGN-NOTES.md (mirrors
 * Flow Overview's header-stats + stacked card-section pattern).
 */
export function EntryPointDetailPage() {
  const { projectId: routeParam, entryPointId: routeEntryPointId } = useParams<{ projectId: string; entryPointId: string }>();
  const navigate = useNavigate();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const query = useEntryPoint(projectId, routeEntryPointId);
  const flowQuery = useEntryPointFlow(projectId, query.entryPoint);

  // `entryPointId` may be a legacy raw id or a stale slug — once useEntryPoint
  // resolves it, converge the URL onto the canonical `name~suffix` slug.
  useEffect(() => {
    if (!routeParam || !routeEntryPointId || !query.entryPoint) return;
    const canonical = encodeSlug(query.entryPoint);
    if (routeEntryPointId !== canonical) navigate(`/codebases/${routeParam}/entry-points/${canonical}`, { replace: true });
  }, [routeParam, routeEntryPointId, query.entryPoint, navigate]);

  if (!projectId) return null;
  if (query.isLoading) return <LoadingState label="Loading entry point…" />;
  if (query.isError) return <ErrorState message="Could not load this entry point." />;
  if (!query.entryPoint) {
    return <EmptyState title="Entry point not found" description="It may have been removed by a newer analysis." />;
  }

  const ep = query.entryPoint;
  const trigger = formatTrigger(ep);
  const security = securityLabel(ep);

  return (
    <Box>
      <PageHeader
        title={ep.name}
        subtitle={ep.description || (looksLikeRawToken(ep.name) ? 'No description available for this code-named entry point.' : undefined)}
        actions={<Chip size="small" color={security.open ? 'default' : 'success'} variant="outlined" label={security.label} />}
      />

      <Stack direction="row" spacing={3} useFlexGap sx={{ mt: 2, mb: 3, flexWrap: 'wrap' }}>
        {isKnownKind(ep.type) ? (
          <Stat label="Kind" value={KIND_META[ep.type].label} icon={<EntryKindIcon kind={ep.type} size={18} />} />
        ) : (
          <Stat label="Kind" value={ep.type} />
        )}
        <Stat label="Address" value={trigger ?? '—'} mono />
        <Stat label="Deployable" value={ep.deployable_name ?? 'Unassigned'} />
        <Stat label="Reach" value={ep.interaction_reach ?? 'unknown'} />
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <FlowCard projectId={routeParam ?? projectId} flow={flowQuery.flow} isLoading={flowQuery.isLoading} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <SecurityCard entryPoint={ep} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <InputCard entryPoint={ep} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <OutputCard entryPoint={ep} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <HandlerCard entryPoint={ep} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <CapabilitiesCard entryPoint={ep} />
        </Grid>
        <Grid size={12}>
          <TelemetryCard entryPoint={ep} />
        </Grid>
      </Grid>
    </Box>
  );
}

function Stat({ label, value, mono, icon }: { label: string; value: string; mono?: boolean; icon?: ReactNode }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 2, py: 1, minWidth: 140 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        {icon}
        <Typography variant="body2" component={mono ? 'code' : 'span'} sx={mono ? { fontFamily: 'monospace' } : undefined}>
          {value}
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}
