import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import type { CasChangeRisk, CasStability } from '../../hooks/useFileNodes';

const RISK_COLOR: Record<CasChangeRisk['risk_level'], 'default' | 'warning' | 'error'> = {
  low: 'default',
  medium: 'default',
  high: 'warning',
  critical: 'error',
};

const STABILITY_COLOR: Record<CasStability['stability_class'], 'default' | 'warning' | 'error'> = {
  stable: 'default',
  evolving: 'default',
  volatile: 'warning',
  fragile: 'error',
};

/**
 * Change risk and temporal stability — present ONLY when the analysis
 * computed them for this node (both are inference-layer facts, not
 * guaranteed for every node; see CASChangeRisk/CASTemporalStability in
 * cas.types.ts). Renders nothing at all when neither is present, the same
 * "absent is a real, honest case" stance the entry-points lane's
 * TelemetryCard takes (DESIGN-NOTES.md) — never a fake "unknown" panel.
 */
export function RiskStabilityCard({ risk, stability }: { risk?: CasChangeRisk; stability?: CasStability }) {
  if (!risk && !stability) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        {risk ? (
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="subtitle2">Change risk</Typography>
              <Chip size="small" color={RISK_COLOR[risk.risk_level]} label={risk.risk_level} />
            </Stack>
            {risk.risk_factors && risk.risk_factors.length > 0 ? (
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {risk.risk_factors.map((f, i) => (
                  <Typography key={`${f.factor}-${i}`} variant="caption" color="text.secondary">
                    {f.factor} ({f.severity}) — {f.details}
                  </Typography>
                ))}
              </Stack>
            ) : null}
          </Box>
        ) : null}
        {stability ? (
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="subtitle2">Stability</Typography>
              <Chip size="small" color={STABILITY_COLOR[stability.stability_class]} label={stability.stability_class} />
              <Typography variant="caption" color="text.secondary">score {stability.stability_score.toFixed(2)}</Typography>
            </Stack>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  );
}
