// Section 04 — Architecture (Figma "Repo overview", node 1647:38159): system
// type + a visual "Architecture Diagram" panel + pattern list. The diagram
// itself (Figma's node-link "System Connection Map") has no live data source
// wired yet — built as an honest placeholder panel rather than a fabricated
// graph; see apps/app/docs/DESIGN-NOTES.md. "See all" -> /architecture.
import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { SectionHeader } from './SectionHeader';
import type { ArchitecturalPatternSummary } from '../casSummary';

export interface ArchitectureSectionProps {
  projectId: string;
  systemType?: string | null;
  patterns: ArchitecturalPatternSummary[];
}

export function ArchitectureSection({ projectId, systemType, patterns }: ArchitectureSectionProps) {
  return (
    <Box component="section" sx={{ mb: 6 }}>
      <SectionHeader
        index="04"
        title="Architecture"
        subtitle="How a request moves through the system."
        seeAllHref={`/codebases/${projectId}/architecture`}
        seeAllLabel="See full Architecture"
      />
      <Paper variant="outlined" sx={{ p: 4 }}>
        <Stack spacing={3}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle1">{systemType || 'Architecture style not yet determined'}</Typography>
          </Stack>
          <Box
            sx={{
              height: 220,
              border: '0.75px dashed',
              borderColor: 'divider',
              borderRadius: 1.5,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              color: 'text.disabled',
            }}
          >
            <AccountTreeOutlinedIcon sx={{ fontSize: 28 }} />
            <Typography variant="caption">
              Architecture diagram — no live component/connection data wired yet
            </Typography>
          </Box>
          {patterns.length > 0 ? (
            <Stack spacing={1}>
              <Typography variant="caption" color="text.disabled">Detected patterns</Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                {patterns.slice(0, 8).map(pattern => (
                  <Chip key={pattern.name} size="small" label={pattern.name} />
                ))}
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      </Paper>
    </Box>
  );
}
