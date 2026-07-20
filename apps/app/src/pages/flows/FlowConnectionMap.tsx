import { Box, Grid, Paper, Stack, Typography } from '@mui/material';
import type { FlowConcept } from '../../api';
import { tokens } from '../../theme';

/**
 * "System Connection Map" (Figma node 1748:7243-pattern reused inside Flow
 * Overview) — reduced to a simple, static SVG per LANE-COMMON's stroke
 * system ("simple SVG/flex chain") rather than the interactive pan/zoom
 * node graph Figma's Workspace screen shows elsewhere; see
 * apps/app/docs/DESIGN-NOTES.md for the scope note (zoom/pan controls
 * deliberately not built).
 *
 * The legend groups Figma showed alongside the map — Entities, Used by,
 * Services, External Systems, Downstream Flows — map onto FlowConcept as
 * follows: Entities <- flow.entities, External Systems <-
 * contract.side_effects.external_integrations. "Used by", "Services", and
 * "Downstream Flows" have no backing field on FlowConcept (no flow-to-flow
 * or flow-to-internal-service relationship exists in the API today) — built
 * with an honest "not available yet" state per the DESIGN FIDELITY RULE,
 * logged as a data gap.
 */
export function FlowConnectionMap({ flow }: { flow: FlowConcept }) {
  const entities = flow.entities;
  const externalSystems = flow.contract.side_effects.external_integrations;

  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">System Connection Map</Typography>
        <Typography variant="caption" color="text.secondary">
          Explore how this flow connects with the system.
        </Typography>
      </Box>
      <Grid container>
        <Grid size={{ xs: 12, md: 6 }} sx={{ p: 3, borderRight: { md: '1px solid' }, borderColor: 'divider' }}>
          <ConnectionDiagram flowName={flow.name} entities={entities} externalSystems={externalSystems} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <LegendGroup label="Entities" items={entities} />
            <LegendGroup label="External systems" items={externalSystems} />
            <LegendGroup label="Used by" items={[]} gapNote="Flow-to-flow caller links are not in the API yet." />
            <LegendGroup label="Downstream flows" items={[]} gapNote="Flow-to-flow forward links are not in the API yet." />
          </Stack>
        </Grid>
      </Grid>
    </Paper>
  );
}

function LegendGroup({ label, items, gapNote }: { label: string; items: string[]; gapNote?: string }) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">{label}</Typography>
      {items.length > 0 ? (
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {items.map(item => <Typography key={item} variant="body2">{item}</Typography>)}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
          {gapNote ?? 'None recorded'}
        </Typography>
      )}
    </Box>
  );
}

/** Static geometry-only node/edge diagram — center flow node, entity and
 *  external-system satellites, straight construction-weight strokes. */
function ConnectionDiagram({ flowName, entities, externalSystems }: { flowName: string; entities: string[]; externalSystems: string[] }) {
  const left = entities.slice(0, 4);
  const right = externalSystems.slice(0, 4);
  const height = Math.max(left.length, right.length, 1) * 44 + 40;
  const centerY = height / 2;

  return (
    <Box component="svg" viewBox={`0 0 360 ${height}`} width="100%" height={height} role="img" aria-label={`Connections for ${flowName}`}>
      <rect x="140" y={centerY - 20} width="80" height="40" rx="6" fill="none" stroke={tokens.wireframe} strokeWidth={1.25} />
      <text x="180" y={centerY + 5} textAnchor="middle" fontSize="11" fill={tokens.textPrimary}>{truncate(flowName, 12)}</text>

      {left.map((label, i) => {
        const y = 20 + i * 44 + 20;
        return (
          <g key={label}>
            <line x1="60" y1={y} x2="140" y2={centerY} stroke={tokens.construction} strokeWidth={0.75} />
            <rect x="0" y={y - 14} width="60" height="28" rx="4" fill="none" stroke={tokens.construction} strokeWidth={0.75} />
            <text x="30" y={y + 4} textAnchor="middle" fontSize="9" fill={tokens.secondaryText}>{truncate(label, 8)}</text>
          </g>
        );
      })}

      {right.map((label, i) => {
        const y = 20 + i * 44 + 20;
        return (
          <g key={label}>
            <line x1="220" y1={centerY} x2="300" y2={y} stroke={tokens.construction} strokeWidth={0.75} />
            <rect x="300" y={y - 14} width="60" height="28" rx="4" fill="none" stroke={tokens.construction} strokeWidth={0.75} />
            <text x="330" y={y + 4} textAnchor="middle" fontSize="9" fill={tokens.secondaryText}>{truncate(label, 8)}</text>
          </g>
        );
      })}
    </Box>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
