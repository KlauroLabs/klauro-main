import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Chip, Grid, Stack, Typography } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { EntryKindIcon } from '@/shared/components/EntryKindIcon';
import { KIND_META, isKnownKind } from '@/shared/components/entryPointKinds';
import { useEntryPoint } from '@/shared/hooks/useEntryPoints';
import { useEntryPointFlow } from '@/shared/hooks/useEntryPointFlow';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { encodeSlug } from '@/shared/lib/slugs';
import { formatTrigger, looksLikeRawToken, securityLabel } from './formatEntryPoint';
import { SecurityCard } from '@/app/EntryPoints/sections/SecurityCard';
import { InputCard } from '@/app/EntryPoints/sections/InputCard';
import { OutputCard } from '@/app/EntryPoints/sections/OutputCard';
import { HandlerCard } from '@/app/EntryPoints/sections/HandlerCard';
import { FlowCard } from '@/app/EntryPoints/sections/FlowCard';
import { CapabilitiesCard } from '@/app/EntryPoints/sections/CapabilitiesCard';
import { TelemetryCard } from '@/app/EntryPoints/sections/TelemetryCard';

export function EntryPointDetailPage() {
  const { projectId: routeParam, entryPointId: routeEntryPointId } = useParams<{ projectId: string; entryPointId: string }>();
  const navigate = useNavigate();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const query = useEntryPoint(projectId, routeEntryPointId);
  const flowQuery = useEntryPointFlow(projectId, query.entryPoint);

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
