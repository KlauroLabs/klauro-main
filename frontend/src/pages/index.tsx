import React from 'react';
import { Box, Container, Typography, Button, Paper } from '@mui/material';
import Link from 'next/link';

const HomePage: React.FC = () => {
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <Typography variant="h3" component="h1" gutterBottom>
          🗺️ Unravl Platform
        </Typography>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          Transform codebases into living, interactive architecture diagrams
        </Typography>
      </Box>
      
      <Box sx={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
        <Paper elevation={2} sx={{ p: 3, minWidth: 300 }}>
          <Typography variant="h5" gutterBottom>
            Blueprint Demo
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Experience the hierarchical blueprint visualization with drill-down navigation and real-time telemetry overlays.
          </Typography>
          <Link href="/demo" passHref>
            <Button variant="contained" fullWidth>
              View Demo
            </Button>
          </Link>
        </Paper>
        
        <Paper elevation={2} sx={{ p: 3, minWidth: 300 }}>
          <Typography variant="h5" gutterBottom>
            Live Visualization
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connect to a real project and explore its architecture with interactive blueprints.
          </Typography>
          <Link href="/visualization?projectId=sample-project" passHref>
            <Button variant="outlined" fullWidth>
              Open Visualization
            </Button>
          </Link>
        </Paper>
      </Box>
    </Container>
  );
};

export default HomePage;