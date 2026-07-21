import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SectionHeader } from './SectionHeader';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import type { ArchitecturalPatternSummary } from '@/app/Codebase/casSummary';
import type { DeployableEvidence } from '@/app/Deployable/dasTypes';
import type { RawCallEdge } from '@/shared/hooks/useArchitectureConcepts';

export interface ArchitectureSectionProps {
  projectId: string;
  systemType?: string | null;
  patterns: ArchitecturalPatternSummary[];
  deployableEvidence: DeployableEvidence[];
  conceptInventory: Record<string, string[]> | undefined;
  conceptEdges: RawCallEdge[];
}

export function ArchitectureSection({ projectId, systemType, patterns, deployableEvidence, conceptInventory, conceptEdges }: ArchitectureSectionProps) {
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
          <ArchitectureDiagram
            projectId={projectId}
            evidence={deployableEvidence}
            conceptInventory={conceptInventory}
            conceptEdges={conceptEdges}
            compact
            onOpenFull={openFull}
          />
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
