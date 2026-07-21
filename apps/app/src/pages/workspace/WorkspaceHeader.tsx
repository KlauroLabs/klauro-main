// Header block for the Workspace screen (Figma node 1748:6595, frames
// "Frame 1597881663"/"Frame 1597881457"/stat row "Frame 1597881835"):
// status dot + "Updated X ago", title + a secondary badge, description,
// then a 5-stat row (Repositories/Capabilities/Flows/Entities/Contributors).
// Breadcrumb + topbar chrome live in AppShell, not here (see CodebaseHeader's
// identical note for the Repo overview screen).
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { WorkspaceAnalysisResponse } from '../../api';
import { formatCount } from './workspaceHelpers';
import { formatRelativeTime } from '../dashboard/formatRelativeTime';
import { StatGlyphIcon, type StatGlyph } from '../../components/icons/StatGlyphIcon';

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

      {/* Figma's stat row (node 1748:6595, "Frame 1597881835") gaps stat
          groups 16px apart, each with an 8px icon-to-text gap and a 4px
          value-to-label gap — not a flat spacing run. */}
      <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
        <Stat glyph="repositories" value={stats.repositories} label="Repositories" />
        <Stat glyph="capabilities" value={stats.capabilities} label="Capabilities" />
        <Stat glyph="flows" value={stats.flows} label="Flows" />
        <Stat glyph="entities" value={stats.entities} label="Entities" />
        <Stat glyph="contributors" value={stats.contributors} label="Contributors" />
      </Stack>
    </Stack>
  );
}

function Stat({ glyph, value, label }: { glyph: StatGlyph; value: number | undefined; label: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Box sx={{ display: 'flex' }}>
        <StatGlyphIcon glyph={glyph} size={16} />
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {formatCount(value)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Stack>
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
