// Section 02 — Critical Flows (Figma "Repo overview", node 1647:37820).
// Preview: the top 3 flows (core-role first), each showing name, role, its
// entry point, and step count, linking into the flow-detail route owned by
// the flows lane (page-flows, unclaimed as of this build — see
// apps/app/docs/SCREEN-MAP.md fallback note). "See all" -> /flows.
import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { SectionHeader } from './SectionHeader';
import type { FlowConcept } from '../../../api';
import { encodeSlug } from '../../../lib/slugs';

const roleOrder: Record<string, number> = { core: 0, supporting: 1, infrastructure: 2 };

export function CriticalFlowsSection({ projectId, flows }: { projectId: string; flows: FlowConcept[] }) {
  const preview = [...flows]
    .sort((a, b) => (roleOrder[a.role ?? 'supporting'] ?? 1) - (roleOrder[b.role ?? 'supporting'] ?? 1))
    .slice(0, 3);

  return (
    <Box component="section" sx={{ mb: 6 }}>
      <SectionHeader
        index="02"
        title="Critical Flows"
        subtitle="Understand your critical flows and their behavior."
        seeAllHref={`/codebases/${projectId}/flows`}
        seeAllLabel="See all Flows"
      />
      {preview.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          No flows were found for this codebase.
        </Paper>
      ) : (
        <Stack spacing={2}>
          {preview.map(flow => (
            <Paper
              key={flow.flow_id}
              component={RouterLink}
              to={`/codebases/${projectId}/flows/${encodeSlug({ id: flow.flow_id, name: flow.name })}`}
              variant="outlined"
              sx={{ p: 3, display: 'block', textDecoration: 'none', color: 'inherit' }}
            >
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="subtitle1">{flow.name}</Typography>
                {flow.role ? <Chip size="small" label={flow.role} /> : null}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{flow.intent}</Typography>
              <Stack direction="row" spacing={2}>
                <Typography variant="caption" color="text.disabled">Entry: {flow.entry_point}</Typography>
                <Typography variant="caption" color="text.disabled">{flow.steps?.length ?? 0} steps</Typography>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
