import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import { SectionHeader } from './SectionHeader';
import { useExternalServices } from '@/shared/hooks/useExternalServices';
import { useLibraries } from '@/shared/hooks/useLibraries';

export function DependenciesSection({ projectId, slug }: { projectId: string; slug?: string }) {
  const servicesQuery = useExternalServices(projectId);
  const librariesQuery = useLibraries(projectId);
  const linkTarget = `/codebases/${slug ?? projectId}/dependencies`;

  const services = servicesQuery.externalServices;
  const libraryCount = librariesQuery.libraries.length;
  const declaredCount = librariesQuery.dependencyManifest?.total ?? 0;
  const isEmpty = services.length === 0 && libraryCount === 0 && declaredCount === 0;

  return (
    <Box component="section" sx={{ mb: 2 }}>
      <SectionHeader
        index="05"
        title="Dependencies"
        subtitle="External services this system relies on."
        seeAllHref={linkTarget}
        seeAllLabel="See all Dependencies"
      />
      {isEmpty ? (
        <Paper
          variant="outlined"
          sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, color: 'text.disabled' }}
        >
          <CloudOutlinedIcon sx={{ fontSize: 28 }} />
          <Typography variant="body2">No external services or declared dependencies found for this codebase.</Typography>
        </Paper>
      ) : (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Stack spacing={2}>
            {services.length > 0 ? (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                {services.slice(0, 8).map(service => (
                  <Chip
                    key={service.id}
                    component={RouterLink}
                    to={linkTarget}
                    clickable
                    icon={<CloudOutlinedIcon sx={{ fontSize: 16 }} />}
                    label={service.name}
                    variant="outlined"
                    size="small"
                  />
                ))}
                {services.length > 8 ? (
                  <Chip label={`+${services.length - 8} more`} size="small" variant="outlined" sx={{ color: 'text.disabled' }} />
                ) : null}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.disabled">
                No named external services detected.
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              {libraryCount} recognized {libraryCount === 1 ? 'library' : 'libraries'}
              {declaredCount > libraryCount ? ` · ${declaredCount} declared in manifests` : ''}
            </Typography>
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
