import React from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  Chip,
  IconButton,
} from '@mui/material';
import {
  Science,
  PlayArrow,
  Code,
  BugReport,
  Memory,
  ChevronRight,
} from '@mui/icons-material';
import { TestEntry } from '../utils/testExtractor';

export interface TestCardProps {
  test: TestEntry;
  onClick?: (test: TestEntry) => void;
  showFile?: boolean;
  compact?: boolean;
}

const TEST_TYPE_COLORS: Record<string, string> = {
  unit: '#4caf50',
  integration: '#2196f3',
  e2e: '#ff9800',
  acceptance: '#9c27b0',
  bdd: '#00bcd4',
  other: '#757575',
};

const TEST_STYLE_ICONS: Record<string, React.ReactNode> = {
  procedural: <Code fontSize="small" />,
  bdd: <PlayArrow fontSize="small" />,
  'property-based': <Science fontSize="small" />,
  snapshot: <Memory fontSize="small" />,
  parameterized: <BugReport fontSize="small" />,
};

export const TestCard: React.FC<TestCardProps> = ({
  test,
  onClick,
  showFile = true,
  compact = false,
}) => {
  const typeColor = TEST_TYPE_COLORS[test.testType] || TEST_TYPE_COLORS.other;

  if (compact) {
    return (
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          cursor: onClick ? 'pointer' : 'default',
          transition: 'all 0.2s ease',
          '&:hover': onClick ? {
            bgcolor: 'action.hover',
            transform: 'translateX(2px)',
          } : {},
          borderLeft: `3px solid ${typeColor}`,
        }}
        onClick={() => onClick?.(test)}
      >
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" fontWeight={500} noWrap sx={{ flex: 1 }}>
              {test.name}
            </Typography>
            <Chip
              label={test.testType}
              size="small"
              sx={{
                bgcolor: typeColor,
                color: 'white',
                height: 20,
                fontSize: '0.65rem',
              }}
            />
            {test.usesMocks && (
              <Chip
                label="Mocks"
                size="small"
                variant="outlined"
                sx={{ height: 20, fontSize: '0.65rem' }}
              />
            )}
          </Stack>
          {onClick && <ChevronRight fontSize="small" color="action" />}
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.2s ease',
        '&:hover': onClick ? {
          bgcolor: 'action.hover',
          boxShadow: 1,
        } : {},
        borderLeft: `4px solid ${typeColor}`,
      }}
      onClick={() => onClick?.(test)}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={600}>
              {test.name}
            </Typography>
            {test.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {test.description}
              </Typography>
            )}
          </Box>
          {onClick && (
            <IconButton size="small">
              <ChevronRight />
            </IconButton>
          )}
        </Stack>

        {showFile && test.file && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: 'monospace' }}
          >
            {test.file}{test.line ? `:${test.line}` : ''}
          </Typography>
        )}

        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Chip
            label={test.testType}
            size="small"
            sx={{
              bgcolor: typeColor,
              color: 'white',
            }}
          />
          <Chip
            icon={TEST_STYLE_ICONS[test.testStyle] as React.ReactElement | undefined}
            label={test.testStyle}
            size="small"
            variant="outlined"
          />
          {test.usesMocks && (
            <Chip
              label="Uses Mocks"
              size="small"
              variant="outlined"
              color="secondary"
            />
          )}
          {test.isAsync && (
            <Chip
              label="Async"
              size="small"
              variant="outlined"
              color="info"
            />
          )}
          {test.assertions && (
            <Chip
              label={`${test.assertions} assertions`}
              size="small"
              variant="outlined"
            />
          )}
        </Stack>

        {test.bddSteps && test.bddSteps.length > 0 && (
          <Box
            sx={{
              mt: 1,
              pl: 2,
              borderLeft: '2px solid',
              borderColor: 'divider',
            }}
          >
            {test.bddSteps.slice(0, 3).map((step, index) => (
              <Typography
                key={index}
                variant="caption"
                component="div"
                sx={{
                  color: step.type === 'given' ? 'info.main' :
                         step.type === 'when' ? 'warning.main' :
                         step.type === 'then' ? 'success.main' :
                         'text.secondary',
                }}
              >
                <strong>{step.type.toUpperCase()}:</strong> {step.text}
              </Typography>
            ))}
            {test.bddSteps.length > 3 && (
              <Typography variant="caption" color="text.disabled">
                +{test.bddSteps.length - 3} more steps
              </Typography>
            )}
          </Box>
        )}

        {test.targets && test.targets.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Tests: {test.targets.join(', ')}
            </Typography>
          </Box>
        )}
      </Stack>
    </Paper>
  );
};

export const TestCardSkeleton: React.FC = () => (
  <Paper variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Box sx={{ width: '60%', height: 24, bgcolor: 'action.hover', borderRadius: 1 }} />
      <Box sx={{ width: '80%', height: 16, bgcolor: 'action.hover', borderRadius: 1 }} />
      <Stack direction="row" spacing={1}>
        <Box sx={{ width: 60, height: 24, bgcolor: 'action.hover', borderRadius: 3 }} />
        <Box sx={{ width: 80, height: 24, bgcolor: 'action.hover', borderRadius: 3 }} />
      </Stack>
    </Stack>
  </Paper>
);

export default TestCard;
