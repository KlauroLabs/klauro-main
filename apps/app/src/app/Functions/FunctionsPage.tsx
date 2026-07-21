import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Stack, Typography } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useFilteredNodes } from '@/shared/hooks/useFileNodes';
import { NodeFilterBar } from './NodeFilterBar';
import { NodeList } from './NodeList';

export function FunctionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);

  const query = useFilteredNodes(projectId, { search, type: type ?? undefined, file: file ?? undefined });

  if (!projectId) return null;
  if (query.isLoading) return <LoadingState label="Loading nodes…" />;
  if (query.isError) return <ErrorState message="Could not load nodes for this codebase." />;

  if (query.allNodes.length === 0) {
    return (
      <EmptyState
        title="No nodes found"
        description="This codebase's analysis found no browsable functions, methods, or types — a real case for an empty or still-analyzing repository."
      />
    );
  }

  return (
    <Box>
      <PageHeader
        title="Functions"
        subtitle={`${query.allNodes.length.toLocaleString()} nodes across ${query.files.length.toLocaleString()} files.`}
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <NodeFilterBar
          search={search}
          onSearchChange={setSearch}
          types={query.types}
          type={type}
          onTypeChange={setType}
          files={query.files}
          file={file}
          onFileChange={setFile}
        />

        {query.filteredNodes.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No nodes match the current search or filters.
          </Typography>
        ) : (
          <NodeList nodes={query.filteredNodes} projectId={projectId} />
        )}
      </Stack>
    </Box>
  );
}
