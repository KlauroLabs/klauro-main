import { Box, Stack, Typography } from '@mui/material';
import type { RemoteDasUnit } from '../../hooks/useDasUnits';

/**
 * Members an installer/compose unit bundles, grouped UNDER their owning
 * unit — never listed as their own top-level rows (they don't count toward
 * the promotion threshold on their own; see dasIndex.ts's
 * tierQualifiedShipUnits). Absent entirely for a unit with no bundled
 * members — the common case (spec §8: "8 runnable binaries, 1 installer
 * bundles 2").
 */
export function DasBundledMembers({ unit }: { unit: RemoteDasUnit }) {
  if (unit.member_root_paths.length === 0) return null;
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        Bundled members ({unit.member_root_paths.length})
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Runnable candidates this unit's evidence names as something it packages, COPYs, or
        installs — folded into this unit rather than counted as ship units of their own.
      </Typography>
      <Stack spacing={0.5}>
        {unit.member_root_paths.map(path => (
          <Typography key={path} variant="body2" component="code" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
            {path}
          </Typography>
        ))}
      </Stack>
    </Box>
  );
}
