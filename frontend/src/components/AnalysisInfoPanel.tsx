import React from 'react';
import {
  Box,
  Drawer,
  Typography,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Chip,
  Divider,
  Stack,
  Paper,
  LinearProgress
} from '@mui/material';
import {
  Close as CloseIcon,
  Code,
  Language,
  Assessment,
  Speed,
  CheckCircle
} from '@mui/icons-material';

interface AnalysisInfoPanelProps {
  open: boolean;
  onClose: () => void;
  analysisData: any;
}

export const AnalysisInfoPanel: React.FC<AnalysisInfoPanelProps> = ({
  open,
  onClose,
  analysisData
}) => {
  if (!analysisData) {
    return (
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        sx={{
          '& .MuiDrawer-paper': {
            width: 400,
            p: 3
          }
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
          <Typography variant="h6" fontWeight={600}>
            Analysis Details
          </Typography>
          <IconButton onClick={onClose} size="small">
            <CloseIcon />
          </IconButton>
        </Box>
        <Typography color="text.secondary">
          No analysis data available
        </Typography>
      </Drawer>
    );
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          width: 400,
          p: 3
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>
          Analysis Details
        </Typography>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </Box>

      {/* Project Overview */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
          <Assessment color="primary" />
          <Typography variant="subtitle1" fontWeight={600}>
            Project Overview
          </Typography>
        </Stack>

        <Typography variant="h4" fontWeight={700} sx={{ mb: 1 }}>
          {analysisData.system?.name || analysisData.name || 'Unknown Project'}
        </Typography>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <Chip
            icon={<Code />}
            label={`${analysisData.nodes?.length || 0} Nodes`}
            size="small"
            color="primary"
            variant="outlined"
          />
          <Chip
            icon={<CheckCircle />}
            label={`${analysisData.edges?.length || 0} Connections`}
            size="small"
            color="info"
            variant="outlined"
          />
          <Chip
            icon={<CheckCircle />}
            label="Analysis Complete"
            size="small"
            color="success"
            variant="outlined"
          />
        </Stack>

        {analysisData.analysis_timestamp && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Analyzed: {new Date(analysisData.analysis_timestamp).toLocaleString()}
          </Typography>
        )}

        {analysisData.system?.type && (
          <Typography variant="body2" color="text.secondary">
            System Type: {analysisData.system.type}
          </Typography>
        )}
      </Paper>

      {/* Metrics */}
      {analysisData.metrics && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
            <Speed color="primary" />
            <Typography variant="subtitle1" fontWeight={600}>
              Code Metrics
            </Typography>
          </Stack>

          <List dense>
            <ListItem>
              <ListItemText
                primary={`${analysisData.metrics.total_files || 0} Files`}
                secondary="Total files analyzed"
              />
            </ListItem>
            <ListItem>
              <ListItemText
                primary={`${analysisData.metrics.total_lines || 0} Lines`}
                secondary="Lines of code"
              />
            </ListItem>
            {analysisData.metrics.coverage && (
              <ListItem>
                <ListItemText
                  primary={
                    <Box>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        Coverage: {Math.round(analysisData.metrics.coverage * 100)}%
                      </Typography>
                      <LinearProgress
                        variant="determinate"
                        value={analysisData.metrics.coverage * 100}
                        sx={{ height: 6, borderRadius: 3 }}
                      />
                    </Box>
                  }
                  secondary="Analysis coverage"
                />
              </ListItem>
            )}
          </List>
        </Paper>
      )}


      {/* Nodes/Components */}
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>
          Nodes ({analysisData.nodes?.length || 0})
        </Typography>

        <List dense sx={{ maxHeight: 300, overflow: 'auto' }}>
          {analysisData.nodes?.slice(0, 10).map((node: any, index: number) => (
            <React.Fragment key={node.id || index}>
              <ListItem>
                <ListItemText
                  primary={node.name}
                  secondary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip
                        label={node.type || 'unknown'}
                        size="small"
                        variant="outlined"
                      />
                      {node.source?.file && (
                        <Typography variant="caption" color="text.secondary">
                          {node.source.file.split('/').pop()}:{node.source.line}
                        </Typography>
                      )}
                    </Stack>
                  }
                />
              </ListItem>
              {index < Math.min(9, (analysisData.nodes?.length || 1) - 1) && <Divider />}
            </React.Fragment>
          ))}

          {analysisData.nodes?.length > 10 && (
            <ListItem>
              <ListItemText
                primary={
                  <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                    And {analysisData.nodes.length - 10} more nodes...
                  </Typography>
                }
              />
            </ListItem>
          )}
        </List>
      </Paper>

      {/* Entry and Exit Points */}
      {(analysisData.entry_points?.length > 0 || analysisData.exit_points?.length > 0) && (
        <Paper sx={{ p: 2, mt: 3 }}>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>
            Entry & Exit Points
          </Typography>

          {analysisData.entry_points?.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" fontWeight={600} color="success.main" sx={{ mb: 1 }}>
                Entry Points ({analysisData.entry_points.length})
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
                {analysisData.entry_points.slice(0, 5).map((entry: any, index: number) => (
                  <Chip
                    key={index}
                    label={entry.name}
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                ))}
                {analysisData.entry_points.length > 5 && (
                  <Typography variant="caption" color="text.secondary">
                    +{analysisData.entry_points.length - 5} more
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          {analysisData.exit_points?.length > 0 && (
            <Box>
              <Typography variant="body2" fontWeight={600} color="error.main" sx={{ mb: 1 }}>
                Exit Points ({analysisData.exit_points.length})
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
                {analysisData.exit_points.slice(0, 5).map((exit: any, index: number) => (
                  <Chip
                    key={index}
                    label={exit.name}
                    size="small"
                    color="error"
                    variant="outlined"
                  />
                ))}
                {analysisData.exit_points.length > 5 && (
                  <Typography variant="caption" color="text.secondary">
                    +{analysisData.exit_points.length - 5} more
                  </Typography>
                )}
              </Stack>
            </Box>
          )}
        </Paper>
      )}
    </Drawer>
  );
};