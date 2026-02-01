import React from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  Chip,
  IconButton,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  Close,
  Code,
  Science,
  CheckCircle,
  Warning,
  ArrowForward,
  PlayArrow,
  Memory,
  Link as LinkIcon,
} from '@mui/icons-material';
import { TestEntry } from '../utils/testExtractor';

export interface TestDetailPanelProps {
  test: TestEntry;
  onClose: () => void;
  onTargetClick?: (targetId: string) => void;
}

const TEST_TYPE_COLORS: Record<string, string> = {
  unit: '#4caf50',
  integration: '#2196f3',
  e2e: '#ff9800',
  acceptance: '#9c27b0',
  bdd: '#00bcd4',
  other: '#757575',
};

const BDD_STEP_COLORS: Record<string, string> = {
  given: '#2196f3',
  when: '#ff9800',
  then: '#4caf50',
  and: '#9e9e9e',
  but: '#f44336',
};

export const TestDetailPanel: React.FC<TestDetailPanelProps> = ({
  test,
  onClose,
  onTargetClick,
}) => {
  const typeColor = TEST_TYPE_COLORS[test.testType] || TEST_TYPE_COLORS.other;

  return (
    <Paper
      sx={{
        width: 400,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: 1,
        borderColor: 'divider',
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          bgcolor: 'background.default',
        }}
      >
        <Typography variant="subtitle1" fontWeight={600} noWrap sx={{ flex: 1 }}>
          Test Details
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <Close fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" fontWeight={600}>
              {test.name}
            </Typography>
            {test.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {test.description}
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={500}>
              FILE
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', mt: 0.5 }}
            >
              {test.file || 'Unknown'}
              {test.line ? `:${test.line}` : ''}
            </Typography>
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={500}>
              TYPE & STYLE
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
              <Chip
                label={test.testType}
                size="small"
                sx={{
                  bgcolor: typeColor,
                  color: 'white',
                }}
              />
              <Chip
                label={test.testStyle}
                size="small"
                variant="outlined"
              />
              <Chip
                label={test.framework}
                size="small"
                variant="outlined"
                color="secondary"
              />
            </Stack>
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={500}>
              STATUS
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
              <Chip
                icon={<CheckCircle fontSize="small" />}
                label="Passing"
                size="small"
                color="success"
                variant="outlined"
              />
              {test.usesMocks && (
                <Chip
                  icon={<Memory fontSize="small" />}
                  label="Uses Mocks"
                  size="small"
                  variant="outlined"
                />
              )}
              {test.isAsync && (
                <Chip
                  icon={<PlayArrow fontSize="small" />}
                  label="Async"
                  size="small"
                  color="info"
                  variant="outlined"
                />
              )}
            </Stack>
          </Box>

          {test.bddSteps && test.bddSteps.length > 0 && (
            <Box>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                BDD STEPS
              </Typography>
              <List dense sx={{ mt: 0.5 }}>
                {test.bddSteps.map((step, index) => (
                  <ListItem
                    key={index}
                    sx={{
                      pl: 0,
                      py: 0.5,
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 60 }}>
                      <Chip
                        label={step.type.toUpperCase()}
                        size="small"
                        sx={{
                          bgcolor: BDD_STEP_COLORS[step.type] || '#757575',
                          color: 'white',
                          fontSize: '0.65rem',
                          height: 20,
                        }}
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={step.text}
                      primaryTypographyProps={{
                        variant: 'body2',
                      }}
                    />
                  </ListItem>
                ))}
              </List>
            </Box>
          )}

          {test.targets && test.targets.length > 0 && (
            <Box>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                CODE UNDER TEST
              </Typography>
              <List dense sx={{ mt: 0.5 }}>
                {test.targets.map((target, index) => (
                  <ListItem
                    key={index}
                    onClick={() => onTargetClick?.(target)}
                    sx={{
                      pl: 0,
                      py: 0.5,
                      borderRadius: 1,
                      cursor: onTargetClick ? 'pointer' : 'default',
                      '&:hover': onTargetClick ? { bgcolor: 'action.hover' } : {},
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      <ArrowForward fontSize="small" color="primary" />
                    </ListItemIcon>
                    <ListItemText
                      primary={target}
                      primaryTypographyProps={{
                        variant: 'body2',
                        fontFamily: 'monospace',
                        color: 'primary.main',
                      }}
                    />
                    {onTargetClick && (
                      <LinkIcon fontSize="small" color="action" />
                    )}
                  </ListItem>
                ))}
              </List>
            </Box>
          )}

          {test.mocksUsed && test.mocksUsed.length > 0 && (
            <Box>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                MOCKS USED
              </Typography>
              <List dense sx={{ mt: 0.5 }}>
                {test.mocksUsed.map((mock, index) => (
                  <ListItem
                    key={index}
                    sx={{
                      pl: 0,
                      py: 0.5,
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      <Memory fontSize="small" color="secondary" />
                    </ListItemIcon>
                    <ListItemText
                      primary={mock}
                      primaryTypographyProps={{
                        variant: 'body2',
                        fontFamily: 'monospace',
                      }}
                    />
                  </ListItem>
                ))}
              </List>
            </Box>
          )}

          {test.assertions && test.assertions > 0 && (
            <Box>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="caption" color="text.secondary" fontWeight={500}>
                ASSERTIONS
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {test.assertions} assertion{test.assertions > 1 ? 's' : ''} in this test
              </Typography>
            </Box>
          )}
        </Stack>
      </Box>
    </Paper>
  );
};

export default TestDetailPanel;
