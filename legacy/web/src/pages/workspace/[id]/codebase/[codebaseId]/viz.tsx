import React from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { Box } from '@mui/material';
import { UnderstandingContainer } from '../../../../../features/visualization';

const CodebaseVisualizationPage: React.FC = () => {
  const router = useRouter();
  const { id: workspaceId, codebaseId } = router.query;

  return (
    <>
      <Head>
        <title>Architecture Visualization | Klauro</title>
      </Head>
      <Box sx={{ height: '100vh', overflow: 'hidden' }}>
        <UnderstandingContainer
          workspaceId={workspaceId as string}
          codebaseId={codebaseId as string}
        />
      </Box>
    </>
  );
};

export default CodebaseVisualizationPage;
