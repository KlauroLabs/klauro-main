import { Box, Chip, Stack, Typography } from '@mui/material';
import type { DasShipEvidenceFields } from '../../hooks/useDasUnits';

/**
 * Ship evidence rendered as construction, not a badge: what this unit
 * packages (ships_paths + the entrypoint member among them), what ports it
 * declares, and what base images its Dockerfile builds from. Sourced from
 * GET /api/projects/:id/cas?das_unit_id= 's `deployable_evidence[0]` (this
 * unit's own evidence row — e9490b69's useDasUnitSlice unpacks it as
 * `shipEvidence`). Any field that's genuinely absent for this unit's kind (a
 * `bin` has no ports; a `compose-service` has no base_images of its own) is
 * simply omitted — an empty ships_paths/ports/base_images list is a real,
 * common case, not an error.
 */
export function DasShipEvidence({ evidence }: { evidence: DasShipEvidenceFields | undefined }) {
  if (!evidence) return null;
  const hasShipsPaths = (evidence.ships_paths?.length ?? 0) > 0;
  const hasPorts = (evidence.ports?.length ?? 0) > 0;
  const hasBaseImages = (evidence.base_images?.length ?? 0) > 0;

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
            {evidence.ships_paths!.map(path => (
              <Chip
                key={path}
                size="small"
                variant={path === evidence.entrypoint_member ? 'filled' : 'outlined'}
                label={path === evidence.entrypoint_member ? `${path} (entrypoint)` : path}
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
            {evidence.ports!.map(port => (
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
            {evidence.base_images!.map((image, i) => (
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
