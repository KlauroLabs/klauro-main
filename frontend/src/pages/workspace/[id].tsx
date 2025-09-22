import React from 'react';
import { useRouter } from 'next/router';
import { Box, Typography, CircularProgress } from '@mui/material';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { CodebasesDashboard } from '@/pages/codebases-dashboard';

export default function WorkspacePage() {
  const router = useRouter();
  const { id } = router.query;
  const { currentWorkspace, switchWorkspace, isLoading } = useWorkspace();

  React.useEffect(() => {
    if (id && typeof id === 'string' && currentWorkspace?.id !== id) {
      switchWorkspace(id);
    }
  }, [id, currentWorkspace, switchWorkspace]);

  if (isLoading || !currentWorkspace) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
        <CircularProgress />
      </Box>
    );
  }

  return <CodebasesDashboard />;
}