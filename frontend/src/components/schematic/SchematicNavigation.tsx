import React from 'react';
import { 
  Box, 
  Breadcrumbs, 
  Link, 
  Typography, 
  IconButton,
  Tooltip,
  Paper
} from '@mui/material';
import { 
  ArrowBack, 
  Home,
  ZoomIn,
  ZoomOut,
  Fullscreen,
  List
} from '@mui/icons-material';

interface SchematicNavigationProps {
  currentPath: Array<{
    id: string;
    name: string;
    level: number;
  }>;
  onNavigateToLevel: (levelId: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFullscreen: () => void;
  onToggleIssuesList: () => void;
  issuesCount: number;
  currentZoom: number;
}

export const SchematicNavigation: React.FC<SchematicNavigationProps> = ({
  currentPath,
  onNavigateToLevel,
  onZoomIn,
  onZoomOut,
  onToggleFullscreen,
  onToggleIssuesList,
  issuesCount,
  currentZoom
}) => {
  return (
    <Paper 
      elevation={2}
      sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        p: 1.5,
        mb: 2,
        bgcolor: 'rgba(0, 8, 20, 0.9)',
        border: '1px solid #00bcd4',
        borderRadius: 1
      }}
    >
      {/* Breadcrumb Navigation */}
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Tooltip title="Go to System Overview">
          <IconButton 
            onClick={() => onNavigateToLevel('root')}
            sx={{ color: '#00bcd4', mr: 1 }}
          >
            <Home />
          </IconButton>
        </Tooltip>

        <Breadcrumbs 
          separator="›" 
          sx={{ 
            '& .MuiBreadcrumbs-separator': { 
              color: '#00bcd4' 
            } 
          }}
        >
          {currentPath.map((level, index) => {
            const isLast = index === currentPath.length - 1;
            
            return (
              <React.Fragment key={level.id}>
                {isLast ? (
                  <Typography 
                    sx={{ 
                      color: '#ffeb3b',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                      fontSize: '14px'
                    }}
                  >
                    {level.name}
                  </Typography>
                ) : (
                  <Link
                    component="button"
                    variant="body2"
                    onClick={() => onNavigateToLevel(level.id)}
                    sx={{
                      color: '#00bcd4',
                      textDecoration: 'none',
                      textTransform: 'uppercase',
                      fontSize: '14px',
                      '&:hover': {
                        color: '#4dd0e1',
                        textDecoration: 'underline'
                      }
                    }}
                  >
                    {level.name}
                  </Link>
                )}
              </React.Fragment>
            );
          })}
        </Breadcrumbs>

        {/* Level Indicator */}
        <Box sx={{ ml: 2 }}>
          <Typography 
            variant="caption" 
            sx={{ 
              color: '#81c784',
              bgcolor: 'rgba(129, 199, 132, 0.1)',
              px: 1,
              py: 0.5,
              borderRadius: 1,
              fontWeight: 'bold'
            }}
          >
            LEVEL {currentPath.length}
          </Typography>
        </Box>
      </Box>

      {/* Controls */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {/* Zoom Level */}
        <Typography 
          variant="caption" 
          sx={{ 
            color: '#00bcd4',
            minWidth: '60px',
            textAlign: 'center'
          }}
        >
          {Math.round(currentZoom * 100)}%
        </Typography>

        {/* Zoom Controls */}
        <Tooltip title="Zoom In">
          <IconButton 
            onClick={onZoomIn}
            disabled={currentZoom >= 2}
            sx={{ 
              color: currentZoom >= 2 ? '#555' : '#00bcd4',
              '&:disabled': { color: '#555' }
            }}
          >
            <ZoomIn fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title="Zoom Out">
          <IconButton 
            onClick={onZoomOut}
            disabled={currentZoom <= 0.5}
            sx={{ 
              color: currentZoom <= 0.5 ? '#555' : '#00bcd4',
              '&:disabled': { color: '#555' }
            }}
          >
            <ZoomOut fontSize="small" />
          </IconButton>
        </Tooltip>

        {/* Issues List Toggle */}
        <Tooltip title="Toggle Issues List">
          <IconButton 
            onClick={onToggleIssuesList}
            sx={{ 
              color: issuesCount > 0 ? '#f44336' : '#00bcd4',
              position: 'relative'
            }}
          >
            <List fontSize="small" />
            {issuesCount > 0 && (
              <Box
                sx={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  bgcolor: '#f44336',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10px',
                  color: 'white',
                  fontWeight: 'bold'
                }}
              >
                {issuesCount > 99 ? '99+' : issuesCount}
              </Box>
            )}
          </IconButton>
        </Tooltip>

        {/* Fullscreen Toggle */}
        <Tooltip title="Toggle Fullscreen">
          <IconButton 
            onClick={onToggleFullscreen}
            sx={{ color: '#00bcd4' }}
          >
            <Fullscreen fontSize="small" />
          </IconButton>
        </Tooltip>

        {/* Back Button */}
        {currentPath.length > 1 && (
          <Tooltip title="Go Back">
            <IconButton 
              onClick={() => {
                const parentLevel = currentPath[currentPath.length - 2];
                onNavigateToLevel(parentLevel.id);
              }}
              sx={{ 
                color: '#ffeb3b',
                ml: 1,
                border: '1px solid #ffeb3b'
              }}
            >
              <ArrowBack fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Paper>
  );
};