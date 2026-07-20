// Section 03 — Key Entities (Figma "Repo overview", node 1647:38019).
// Preview: entity NAMES only — the summary API (GET /api/projects/:id/analysis)
// carries `database_entities: string[]` with no field/kind/reader-writer
// detail (that richer shape lives behind GET /api/projects/:id/entities,
// owned by the page-entities lane). See apps/app/docs/DESIGN-NOTES.md.
// "See all" -> /entities (page-entities' route).
import { Box, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import { SectionHeader } from './SectionHeader';

export function KeyEntitiesSection({ projectId, entityNames }: { projectId: string; entityNames: string[] }) {
  const preview = entityNames.slice(0, 5);
  return (
    <Box component="section" sx={{ mb: 6 }}>
      <SectionHeader
        index="03"
        title="Key Entities"
        subtitle="Core business objects used across critical flows."
        seeAllHref={`/codebases/${projectId}/entities`}
        seeAllLabel="See all Entities"
      />
      {preview.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          No entities were found for this codebase.
        </Paper>
      ) : (
        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
          {preview.map(name => (
            <Paper
              key={name}
              component={RouterLink}
              to={`/codebases/${projectId}/entities`}
              variant="outlined"
              sx={{ p: 2.5, width: 200, textDecoration: 'none', color: 'inherit' }}
            >
              <StorageOutlinedIcon sx={{ fontSize: 20, color: 'text.disabled', mb: 1 }} />
              <Typography variant="subtitle2">{name}</Typography>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
