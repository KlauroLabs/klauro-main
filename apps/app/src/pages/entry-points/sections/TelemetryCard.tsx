import { Box, Stack, Typography } from '@mui/material';
import type { EntryPoint } from '../../../hooks/useEntryPoints';

/**
 * What we know once it's running — present only for a deployment that is
 * running and instrumented (brief, "The live layer"); absent for everything
 * else. See DESIGN-NOTES.md ("Telemetry has no wired data source yet") for
 * why this reads from metadata.telemetry rather than a dedicated field.
 * Renders NOTHING (not an empty card) when telemetry is absent, per the
 * brief: "design the entry-point row to look complete without them."
 */
export function TelemetryCard({ entryPoint }: { entryPoint: EntryPoint }) {
  const t = entryPoint.metadata?.telemetry;
  if (!t) return null;

  const stats: Array<{ label: string; value: string }> = [];
  if (t.request_count !== undefined) stats.push({ label: 'calls in the last day', value: formatCount(t.request_count) });
  if (t.error_rate !== undefined) stats.push({ label: 'share of calls that failed', value: `${t.error_rate}%` });
  if (t.p50_ms !== undefined) stats.push({ label: 'median response (p50)', value: `${t.p50_ms}ms` });
  if (t.p95_ms !== undefined || t.p99_ms !== undefined) {
    stats.push({ label: 'slow tail (p95/p99)', value: `${t.p95_ms ?? '—'}/${t.p99_ms ?? '—'}ms` });
  }
  if (stats.length === 0) return null;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        What we know once it's running
      </Typography>
      <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {stats.map(s => (
          <Box key={s.label}>
            <Typography variant="h6" component="div">
              {s.value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {s.label}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
