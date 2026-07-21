import { useNavigate } from 'react-router-dom';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { DataEntityLifecycle } from '@/shared/hooks/useEntities';
import { formatFunctionNodeLabel } from '@/app/Entities/formatFunctionNode';

const GROUPS: Array<{ key: keyof DataEntityLifecycle; label: string }> = [
  { key: 'created_by', label: 'Created by' },
  { key: 'read_by', label: 'Read by' },
  { key: 'updated_by', label: 'Updated by' },
  { key: 'deleted_by', label: 'Deleted by' },
];

export function EntityLineage({ lifecycle, projectId }: { lifecycle: DataEntityLifecycle; projectId: string }) {
  const navigate = useNavigate();
  const groupsWithData = GROUPS.filter(g => lifecycle[g.key].length > 0);

  if (groupsWithData.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No reader or writer functions were traced for this entity.
      </Typography>
    );
  }

  return (
    <Stack spacing={2}>
      {groupsWithData.map(group => (
        <Box key={group.key}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {group.label} ({lifecycle[group.key].length})
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {lifecycle[group.key].map(nodeId => (
              <Chip
                key={nodeId}
                size="small"
                variant="outlined"
                label={formatFunctionNodeLabel(nodeId)}
                onClick={() => navigate(`/codebases/${projectId}/functions/${encodeURIComponent(nodeId)}`)}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
