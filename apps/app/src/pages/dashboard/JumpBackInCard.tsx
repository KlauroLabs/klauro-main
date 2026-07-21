import { Box, Chip, IconButton, Stack, Typography } from '@mui/material';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import { Link as RouterLink } from 'react-router-dom';
import type { Project } from '../../api';
import { StatGlyphIcon, type StatGlyph } from '../../components/icons/StatGlyphIcon';
import { useProjectSummary } from '../../hooks/useProjectSummary';
import { getLastOpenedAt } from '../../hooks/useRecentProjectViews';
import { formatRelativeTime } from './formatRelativeTime';
import { encodeSlug } from '../../lib/slugs';

export interface JumpBackInTarget {
  project: Project;
  workspaceId: string;
  workspaceName: string;
}

/**
 * Figma "Home" (node 1698-13626): "Jump Back In" section — one card for the
 * most recently touched project. Of the design's stat row (Lines /
 * Capabilities / Contributors) and "Last Opened" timestamp:
 * - **Capabilities** IS available (`AnalysisSummary.capabilities` via the
 *   same `useProjectSummary` hook CodebaseOverview already uses) — wired
 *   below, react-query-deduped against CodebaseOverview's identical query
 *   key the moment this project has actually been opened once.
 * - **Contributors** is now wired to `AnalysisSummary.repo_facts.
 *   contributor_count` (e9490b69) — the same field CodebaseStats.tsx reads.
 * - **Last Opened** is now real, client-side data (`useRecentProjectViews.ts`
 *   — recorded by `CodebasePage` on every visit); honest "—" until this
 *   browser has actually opened the project once.
 * - **Lines** remains a true gap — no lines-of-code metric exists anywhere
 *   in the API surface this page can reach (see apps/app/docs/DESIGN-NOTES.md).
 */
export function JumpBackInCard({ target }: { target: JumpBackInTarget }) {
  const summaryQuery = useProjectSummary(target.project.id);
  const capabilities = summaryQuery.data?.status === 'ready' ? summaryQuery.data.summary?.capabilities : undefined;
  const contributors = summaryQuery.data?.status === 'ready' ? summaryQuery.data.summary?.repo_facts?.contributor_count : undefined;
  const lastOpenedAt = getLastOpenedAt(target.project.id);
  const lastOpenedLabel = formatRelativeTime(lastOpenedAt);

  return (
    <Box
      sx={{
        bgcolor: 'action.hover',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        px: 3,
        py: 2.5,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack spacing={1.5}>
          <Chip label="Repo" size="small" variant="outlined" sx={{ alignSelf: 'flex-start' }} />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
            <Typography variant="h6" component="span">
              {target.project.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {target.workspaceName}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={4}>
            <JumpBackInStat glyph="lines" label="Lines" value="—" />
            <JumpBackInStat glyph="capabilities" label="Capabilities" value={capabilities !== undefined ? String(capabilities) : '—'} />
            <JumpBackInStat glyph="contributors" label="Contributors" value={contributors !== undefined ? String(contributors) : '—'} />
          </Stack>
          <Typography variant="caption" color="text.disabled">
            Last Opened {lastOpenedLabel ?? '—'}
          </Typography>
        </Stack>
        <IconButton
          component={RouterLink}
          to={`/codebases/${encodeSlug(target.project)}`}
          size="small"
          sx={{ border: 1, borderColor: 'divider' }}
          aria-label={`Open ${target.project.name}`}
        >
          <ArrowOutwardIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}

function JumpBackInStat({ glyph, label, value }: { glyph: StatGlyph; label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <StatGlyphIcon glyph={glyph} />
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Stack>
    </Stack>
  );
}
