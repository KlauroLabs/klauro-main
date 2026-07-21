import { Box, Stack, Typography } from '@mui/material';
import type { FlowConcept } from '@/shared/api/index';
import { FlowRoleBadge } from './FlowRoleBadge';
import { linkedCapabilityCount } from './flowFormat';

export function FlowDetailHeader({ flow, updated }: { flow: FlowConcept; updated: string | null }) {
  return (
    <Box>
      {updated ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main' }} />
          <Typography variant="caption" color="text.secondary">Updated {updated}</Typography>
        </Stack>
      ) : null}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Typography variant="h4" component="h1">{flow.name}</Typography>
        <FlowRoleBadge role={flow.role} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 720 }}>
        {flow.intent}
      </Typography>

      <Stack direction="row" spacing={4} sx={{ mt: 3, flexWrap: 'wrap', rowGap: 2 }}>
        <Stat value={flow.steps.length} label="Steps" />
        <Stat value={flow.entities.length} label="Entities touched" />
        <Stat value={linkedCapabilityCount(flow)} label="Capabilities linked" />
        <Stat value={flow.contract.side_effects.external_integrations.length} label="External integrations" />
      </Stack>
    </Box>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <Box>
      <Typography variant="h6">{value}</Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Box>
  );
}
