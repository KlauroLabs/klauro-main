import { Box, Chip, Stack, Typography } from '@mui/material';
import type { DataEntity } from './dasTypes';

export function DasEntities({ entities, files }: { entities: DataEntity[]; files: string[] }) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Files under this unit's root ({files.length})
        </Typography>
        {files.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No files resolved under this root path in the current analysis.
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {files.length} file{files.length === 1 ? '' : 's'} — see individual entities and entry points below for the ones worth naming.
          </Typography>
        )}
      </Box>

      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Data entities ({entities.length})
        </Typography>
        {entities.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No data entities resolve to this unit — a real case for an infrastructure or
            glue-code unit with no persisted shapes of its own.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {entities.map(e => (
              <Chip key={e.id} size="small" variant="outlined" label={e.kind ? `${e.name} · ${e.kind}` : e.name} />
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
