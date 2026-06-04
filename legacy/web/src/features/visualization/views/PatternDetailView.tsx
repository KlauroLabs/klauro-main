import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Chip,
  List,
  ListItemButton,
  ListItemText,
  Alert,
  Divider,
} from '@mui/material';
import {
  Pattern,
  Warning,
  ChevronRight,
} from '@mui/icons-material';
import { CASPattern, CASNode } from '../types';

export interface PatternDetailViewProps {
  pattern: CASPattern;
  nodes: CASNode[];
  onNodeSelect: (nodeId: string) => void;
}

const MEANINGFUL_NODE_TYPES = new Set(['class', 'interface', 'controller', 'service', 'repository', 'guard', 'module', 'component', 'decorator']);

export const PatternDetailView: React.FC<PatternDetailViewProps> = ({
  pattern,
  nodes,
  onNodeSelect,
}) => {
  const isAntiPattern = pattern.id.includes('anti-pattern');
  const hasDeviations = pattern.deviations && pattern.deviations.length > 0;

  const implementations = pattern.instances
    .map(id => nodes.find(n => n.id === id))
    .filter((n): n is CASNode => n !== undefined && MEANINGFUL_NODE_TYPES.has(n.type));

  return (
    <Box sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 3, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center">
          {isAntiPattern ? (
            <Warning color="warning" sx={{ fontSize: 32 }} />
          ) : (
            <Pattern color="primary" sx={{ fontSize: 32 }} />
          )}
          <Box>
            <Typography variant="h5" fontWeight={700}>
              {pattern.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {implementations.length} implementation{implementations.length !== 1 ? 's' : ''} | {Math.round(pattern.confidence * 100)}% confidence
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Box sx={{ p: 3, maxWidth: 900 }}>
        {pattern.description && (
          <Typography variant="body1" sx={{ mb: 3 }}>
            {pattern.description}
          </Typography>
        )}

        {hasDeviations && (
          <Box sx={{ mb: 4 }}>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
              Issues
            </Typography>
            <Stack spacing={2}>
              {pattern.deviations!.map((deviation, idx) => (
                <Alert
                  key={idx}
                  severity={deviation.severity === 'error' ? 'error' : deviation.severity === 'warning' ? 'warning' : 'info'}
                >
                  <Typography variant="body2" fontWeight={500}>
                    {deviation.description}
                  </Typography>
                  {deviation.recommendation && (
                    <Typography variant="body2" sx={{ mt: 1, fontStyle: 'italic' }}>
                      {deviation.recommendation}
                    </Typography>
                  )}
                </Alert>
              ))}
            </Stack>
          </Box>
        )}

        {implementations.length > 0 && (
          <Box>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
              Implementations
            </Typography>
            <Paper variant="outlined">
              <List disablePadding>
                {implementations.map((node, idx) => (
                  <React.Fragment key={node.id}>
                    {idx > 0 && <Divider />}
                    <ListItemButton onClick={() => onNodeSelect(node.id)}>
                      <ListItemText
                        primary={
                          <Typography variant="body1" fontWeight={500}>
                            {node.name}
                          </Typography>
                        }
                        secondary={
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                            <Chip label={node.type} size="small" sx={{ height: 20, fontSize: '0.7rem' }} />
                            {node.source?.file && (
                              <Typography variant="caption" color="text.secondary">
                                {node.source.file.split('/').pop()}
                              </Typography>
                            )}
                          </Stack>
                        }
                      />
                      <ChevronRight color="action" />
                    </ListItemButton>
                  </React.Fragment>
                ))}
              </List>
            </Paper>
          </Box>
        )}

        {implementations.length === 0 && (
          <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
            <Typography color="text.secondary">
              No concrete implementations found for this pattern.
            </Typography>
          </Paper>
        )}
      </Box>
    </Box>
  );
};
