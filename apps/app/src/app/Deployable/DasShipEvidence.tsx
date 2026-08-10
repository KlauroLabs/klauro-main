import { Box, Chip, Stack, Typography } from '@mui/material';
import type { DasShipEvidenceFields } from '@/shared/hooks/useSubCasNodes';

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
