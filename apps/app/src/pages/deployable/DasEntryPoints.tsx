import { Box, Chip, Stack, Typography } from '@mui/material';
import { EntryPointTable } from '../entry-points/EntryPointTable';
import type { EntryPoint } from '../../hooks/useEntryPoints';
import type { UnitCapability } from './dasScope';

/**
 * This unit's entry points (reusing entry-points lane's EntryPointTable —
 * in-flight reuse per LANE-COMMON's fabric protocol) plus the capabilities
 * they collectively serve, aggregated straight off each entry point's own
 * `capabilities` field. No separate system_capabilities lookup: an entry
 * point already carries capability_id/name/role, and a capability with zero
 * scoped entry points below this unit simply doesn't appear — never a
 * fabricated placeholder.
 */
export function DasEntryPoints({ entryPoints, capabilities, projectId }: { entryPoints: EntryPoint[]; capabilities: UnitCapability[]; projectId: string }) {
  return (
    <Stack spacing={2}>
      {capabilities.length > 0 ? (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Capabilities this unit serves ({capabilities.length})
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {capabilities.map(c => (
              <Chip key={c.capability_id} size="small" variant="outlined" label={`${c.capability_name} · ${c.role}`} />
            ))}
          </Stack>
        </Box>
      ) : null}

      {entryPoints.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No entry points attributed to this unit's root path yet.
        </Typography>
      ) : (
        <EntryPointTable entryPoints={entryPoints} projectId={projectId} />
      )}
    </Stack>
  );
}
