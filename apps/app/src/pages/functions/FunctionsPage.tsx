import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Stack, Typography } from '@mui/material';
import { PageHeader } from '../../layout/PageHeader';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { useFilteredNodes } from '../../hooks/useFileNodes';
import { NodeFilterBar } from './NodeFilterBar';
import { NodeList } from './NodeList';

/**
 * The node browser — route /codebases/:projectId/functions. The finest
 * drilldown: search/filter every function, method, class, and other
 * browsable node in the codebase by type and file. Derived layout — no
 * Figma frame for this route (see SCREEN-MAP.md); mirrors the Flow List
 * screen's catalog pattern, the same derivation the entry-points lane used
 * for its own list page. Full rationale: docs/briefs/functions.md.
 */
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
