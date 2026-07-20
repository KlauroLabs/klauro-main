import { Box, Stack, Typography } from '@mui/material';
import type { FlowConcept } from '../../api';
import { FlowRoleBadge } from './FlowRoleBadge';
import { linkedCapabilityCount } from './flowFormat';

/**
 * Flow Overview header (Figma node 1982:6011-6034). Two adaptations from
 * the mock, both logged in apps/app/docs/DESIGN-NOTES.md:
 *  - The description shown in Figma is the CODEBASE'S description (reused
 *    placeholder copy, same text as the Repo overview/Workspace screens) —
 *    this build shows the flow's own `intent` instead, which is the
 *    data-grounded equivalent for a flow-scoped page.
 *  - The header's badge-with-help-icon and the five-pill stat row ("42" x4,
 *    "6") have no identifiable backing field (repeated "42" values read as
 *    Figma sample content, not real distinct metrics) — replaced with a
 *    role badge and four pills this flow's own data actually supports
 *    (steps, entities touched, capabilities linked, external integrations)
 *    rather than guessing at the mock's numbers.
 */
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
