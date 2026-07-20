import { Box, Chip, Stack, Typography } from '@mui/material';
import type { DasUnitSummary } from './dasIndex';

/**
 * Ship evidence rendered as construction, not a badge: what this unit
 * packages (ships_paths + the entrypoint member among them), what ports it
 * declares, and what base images its Dockerfile builds from. Any field
 * that's genuinely absent for this unit's kind (a `bin` has no ports; a
 * `compose-service` has no base_images of its own) is simply omitted — an
 * empty ships_paths/ports/base_images list is a real, common case, not an
 * error.
 */
export function DasShipEvidence({ unit }: { unit: DasUnitSummary }) {
  const hasShipsPaths = (unit.ships_paths?.length ?? 0) > 0;
  const hasPorts = (unit.ports?.length ?? 0) > 0;
  const hasBaseImages = (unit.base_images?.length ?? 0) > 0;

  if (!hasShipsPaths && !hasPorts && !hasBaseImages) return null;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
        Ship evidence
      </Typography>

      {hasShipsPaths ? (
        <Box sx={{ mb: hasPorts || hasBaseImages ? 2 : 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Packages / COPYs / bundles
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {unit.ships_paths!.map(path => (
              <Chip
                key={path}
                size="small"
                variant={path === unit.entrypoint_member ? 'filled' : 'outlined'}
                label={path === unit.entrypoint_member ? `${path} (entrypoint)` : path}
              />
            ))}
          </Stack>
        </Box>
      ) : null}

      {hasPorts ? (
        <Box sx={{ mb: hasBaseImages ? 2 : 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Port bindings
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {unit.ports!.map(port => (
              <Chip key={port} size="small" variant="outlined" label={port} />
            ))}
          </Stack>
        </Box>
      ) : null}

      {hasBaseImages ? (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Base images (Dockerfile FROM)
          </Typography>
          <Stack spacing={0.5}>
            {unit.base_images!.map((image, i) => (
              <Typography key={i} variant="body2" component="code" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {image}
              </Typography>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}
