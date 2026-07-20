// Section 05 — Dependencies (Figma "Repo overview", node 1647:40088):
// external services this system relies on (Stripe/Postgres/Auth0-style
// chips in the design). No web-API route serves this yet — neither
// GET /api/projects/:id/analysis nor /conceptual carry external-service data
// (get_external_services/get_dependencies are MCP-only today). Built as an
// honest empty state; see apps/app/docs/DESIGN-NOTES.md. "See all" ->
// /dependencies (also an honest-empty derived page).
import { Box, Paper, Typography } from '@mui/material';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import { SectionHeader } from './SectionHeader';

export function DependenciesSection({ projectId }: { projectId: string }) {
  return (
    <Box component="section" sx={{ mb: 2 }}>
      <SectionHeader
        index="05"
        title="Dependencies"
        subtitle="External services this system relies on."
        seeAllHref={`/codebases/${projectId}/dependencies`}
        seeAllLabel="See all Dependencies"
      />
      <Paper
        variant="outlined"
        sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, color: 'text.disabled' }}
      >
        <CloudOutlinedIcon sx={{ fontSize: 28 }} />
        <Typography variant="body2">External-service data isn't wired up for the web app yet.</Typography>
      </Paper>
    </Box>
  );
}
