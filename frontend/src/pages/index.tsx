import React, { useEffect } from 'react';
import { useRouter } from 'next/router';
import { Box, CircularProgress, Typography } from '@mui/material';

const HomePage: React.FC = () => {
  const router = useRouter();

  useEffect(() => {
    // Redirect to projects page to eliminate duplication
    router.replace('/projects');
  }, [router]);

  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      minHeight="100vh"
      gap={2}
    >
      <CircularProgress />
      <Typography variant="body1" color="text.secondary">
        Redirecting to projects...
      </Typography>
    </Box>
  );
};

export default HomePage;