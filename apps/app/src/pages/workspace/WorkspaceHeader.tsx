// Header block for the Workspace screen (Figma node 1748:6595, frames
// "Frame 1597881663"/"Frame 1597881457"/stat row "Frame 1597881835"):
// status dot + "Updated X ago", title + a secondary badge, description,
// then a 5-stat row (Repositories/Capabilities/Flows/Entities/Contributors).
// Breadcrumb + topbar chrome live in AppShell, not here (see CodebaseHeader's
// identical note for the Repo overview screen).
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import LayersOutlined from '@mui/icons-material/LayersOutlined';
import CategoryOutlined from '@mui/icons-material/CategoryOutlined';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import StorageOutlined from '@mui/icons-material/StorageOutlined';
import GroupOutlined from '@mui/icons-material/GroupOutlined';
import type { ReactNode } from 'react';
import type { WorkspaceAnalysisResponse } from '../../api';
import { formatCount } from './workspaceHelpers';
import { formatRelativeTime } from '../dashboard/formatRelativeTime';

type WorkspaceGraph = NonNullable<WorkspaceAnalysisResponse['analysis']>;

export interface WorkspaceHeaderProps {
  name: string;
  narrative?: WorkspaceGraph['workspace_narrative'];
  generatedAt?: string;
  enrichmentStatus?: WorkspaceAnalysisResponse['enrichment'];
  lastAttempt?: WorkspaceAnalysisResponse['last_attempt'];
  stats: { repositories?: number; capabilities?: number; flows?: number; entities?: number; contributors?: number };
}

const statusColor: Record<string, string> = {
  ai: 'success.main',
  degraded: 'warning.main',
  error: 'error.main',
  skipped: 'text.disabled',
  pending: 'text.disabled',
};

export function WorkspaceHeader({ name, narrative, generatedAt, enrichmentStatus, lastAttempt, stats }: WorkspaceHeaderProps) {
  const relative = formatRelativeTime(generatedAt);
  const dotColor = statusColor[enrichmentStatus?.status ?? ''] ?? 'text.disabled';
  const tooltipText = enrichmentTooltip(enrichmentStatus, lastAttempt);

  return (
    <Stack spacing={2}>
      {relative ? (
        <Tooltip title={tooltipText} arrow placement="right">
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: 'fit-content', cursor: 'default' }}>
            <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: dotColor }} />
            <Typography variant="caption" color="text.secondary">
              Updated {relative}
            </Typography>
          </Stack>
        </Tooltip>
      ) : null}

      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Typography variant="h4" component="h1">
          {name}
        </Typography>
        {/* Figma pairs the title with a secondary badge ("GitHub" in the mock) — a
            workspace has no single source repository, so this is built with an
            honest generic label rather than a fabricated link. See DESIGN-NOTES.md. */}
        <Chip size="small" variant="outlined" label="Workspace" />
      </Stack>

      {narrative?.description ? (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 900 }}>
          {narrative.description}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ maxWidth: 900 }}>
          No narrative yet — the workspace summary is written once enrichment finishes.
        </Typography>
      )}

      <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap' }}>
        <Stat icon={<LayersOutlined fontSize="inherit" />} value={stats.repositories} label="Repositories" />
        <Stat icon={<CategoryOutlined fontSize="inherit" />} value={stats.capabilities} label="Capabilities" />
        <Stat icon={<AccountTreeOutlined fontSize="inherit" />} value={stats.flows} label="Flows" />
        <Stat icon={<StorageOutlined fontSize="inherit" />} value={stats.entities} label="Entities" />
        <Stat icon={<GroupOutlined fontSize="inherit" />} value={stats.contributors} label="Contributors" />
      </Stack>
    </Stack>
  );
}

function Stat({ icon, value, label }: { icon: ReactNode; value: number | undefined; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box sx={{ display: 'flex', color: 'text.secondary', fontSize: 16 }}>{icon}</Box>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {formatCount(value)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}

function enrichmentTooltip(
  enrichment: WorkspaceAnalysisResponse['enrichment'],
  lastAttempt: WorkspaceAnalysisResponse['last_attempt'],
): string {
  if (lastAttempt?.state === 'failed') return `Last rebuild failed: ${lastAttempt.reason ?? 'unknown reason'}`;
  if (enrichment?.status === 'degraded') return `Narrative degraded: ${enrichment.reason ?? enrichment.error ?? 'unknown reason'}`;
  if (enrichment?.status === 'error') return `Narrative error: ${enrichment.error ?? 'unknown error'}`;
  if (enrichment?.status === 'pending') return 'Narrative is still being generated.';
  if (enrichment?.status === 'ai') return 'Narrative generated by AI comprehension.';
  return 'Freshness of the last workspace analysis.';
}
