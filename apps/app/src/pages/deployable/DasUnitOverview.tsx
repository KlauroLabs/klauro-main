import { Box, Chip, Stack, Typography } from '@mui/material';
import type { DasUnitSummary } from './dasIndex';
import { TIER_LABEL, KIND_LABEL } from './dasLabels';

/**
 * The unit header: id/name/root/tier/kind, plus boundary evidence — the
 * concrete file paths / manifest keys / port bindings that made the
 * analyzer call this a ship unit in the first place. Evidence IS the
 * product (LANE-COMMON.md) so it's rendered here, not hidden behind a
 * tooltip.
 *
 * Deliberately does NOT show node/entry/exit counts — those come only from
 * the true DAS reachability slice (get_summary with a das_unit_id scope),
 * an MCP-only surface today. See DasOrphanNotice.tsx for the same honesty
 * applied to orphan accounting.
 */
export function DasUnitOverview({ unit }: { unit: DasUnitSummary }) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h2">
          {unit.name}
        </Typography>
        <Chip size="small" variant="outlined" label={TIER_LABEL[unit.tier]} />
        <Chip size="small" variant="outlined" label={KIND_LABEL[unit.kind]} />
      </Stack>

      <Typography variant="body2" component="code" color="text.secondary" sx={{ display: 'block', mt: 1, fontFamily: 'monospace' }}>
        {unit.root_path || '.'}
      </Typography>

      {unit.boundary_evidence.length > 0 ? (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Boundary evidence — why this counts as its own ship unit
          </Typography>
          <Stack spacing={0.5}>
            {unit.boundary_evidence.map((line, i) => (
              <Typography key={i} variant="body2" component="code" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {line}
              </Typography>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}
