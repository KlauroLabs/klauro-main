// Section 04 — Architecture (Figma "Repo overview", node 1647:38159): system
// type + a visual "Architecture Diagram" panel + pattern list. The diagram
// panel (Figma's node-link "Architecture Diagram") now renders real
// deployable_evidence nodes/bundled_into edges via the shared
// ArchitectureDiagram component (clickables-diagrams lane) — see
// apps/app/docs/briefs/diagrams.md for the data source and
// apps/app/docs/DESIGN-NOTES.md for what's still a gap (true communication-
// seam edges). "See all" -> /architecture.
import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SectionHeader } from './SectionHeader';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import type { ArchitecturalPatternSummary } from '../casSummary';
import type { DeployableEvidence } from '../../deployable/dasTypes';

export interface ArchitectureSectionProps {
  projectId: string;
  systemType?: string | null;
  patterns: ArchitecturalPatternSummary[];
  deployableEvidence: DeployableEvidence[];
}

export function ArchitectureSection({ projectId, systemType, patterns, deployableEvidence }: ArchitectureSectionProps) {
  const navigate = useNavigate();
  const openFull = () => navigate(`/codebases/${projectId}/architecture`);

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
          <ArchitectureDiagram projectId={projectId} evidence={deployableEvidence} compact onOpenFull={openFull} />
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
