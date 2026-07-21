// Header block for the CAS home (Figma "Repo overview", node 1647:37709,
// frame "Frame 1597881692"): status badge ("Updated X ago") + title + a
// "GitHub" pill badge on one line, description below, two actions (Edit
// Summary / Re-Analyze) at the far right. Lives above the topbar/breadcrumb
// chrome, which is AppShell's job (ui-scaffold), not this page's.
//
// FIDELITY FIX (this pass): the badge next to the title used to render
// `AnalysisSummary.type` (e.g. "service") as a plain filled Chip.
// get_design_context on node 1647:40202 shows the badge Figma actually
// designs here is a bordered rounded-16 pill containing a GitHub mark +
// "GitHub" text — never a repo-type label; `type` doesn't appear anywhere
// on this frame. That Chip was an added element the Figma doesn't show
// (removed for fidelity, was: `<Chip size="small" label={type} />` showing
// the codebase's `type` field). See apps/app/docs/DESIGN-NOTES.md — no
// route reachable from this page carries `Project.repo_url` (the field
// exists on `Project`, api.ts:24, but `GET /api/projects/:id/analysis` — the
// only per-project fetch this page makes — doesn't carry it), so the real
// GitHub badge isn't wired yet; removing the wrong element takes priority
// over leaving a mislabeled one in place while that gap is closed.
import { Box, Stack, Tooltip, Typography, Button } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/EditOutlined';
import { describeFreshness } from '../../lib/freshness';

export interface CodebaseHeaderProps {
  name: string;
  description?: string | null;
  analysisTimestamp?: string | null;
  /** repo_facts.last_commit_at — the honest "source as of" marker (the last
   *  real commit the analyzed snapshot reflects), distinct from when the
   *  analysis job itself ran. See src/lib/freshness.ts. */
  sourceAt?: string | null;
  onReanalyze?: () => void;
  reanalyzing?: boolean;
}

export function CodebaseHeader({ name, description, analysisTimestamp, sourceAt, onReanalyze, reanalyzing }: CodebaseHeaderProps) {
  const freshness = describeFreshness(analysisTimestamp, sourceAt);
  return (
    <Stack spacing={1.5} sx={{ mb: 3 }}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Stack spacing={1}>
          {freshness ? (
            <Tooltip title={freshness.staleNotice ?? ''} arrow placement="right" disableHoverListener={!freshness.stale}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: 'fit-content', cursor: freshness.stale ? 'default' : undefined }}>
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: freshness.stale ? 'warning.main' : 'primary.main' }} />
                <Typography variant="caption" color="text.secondary">
                  {freshness.label}
                </Typography>
              </Stack>
            </Tooltip>
          ) : null}
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="h4" component="h1">{name}</Typography>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1.5}>
          <Button variant="outlined" startIcon={<EditIcon fontSize="small" />}>Edit Summary</Button>
          <Button variant="contained" startIcon={<RefreshIcon fontSize="small" />} onClick={onReanalyze} disabled={reanalyzing}>
            {reanalyzing ? 'Re-analyzing…' : 'Re-Analyze'}
          </Button>
        </Stack>
      </Stack>
      {description ? (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 900 }}>
          {description}
        </Typography>
      ) : null}
    </Stack>
  );
}
