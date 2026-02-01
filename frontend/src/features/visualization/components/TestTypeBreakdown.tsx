import React from 'react';
import { Box, Tooltip, Typography, Stack } from '@mui/material';

export interface TestTypeBreakdownProps {
  byType: {
    unit: number;
    integration: number;
    e2e: number;
    acceptance: number;
  };
  height?: number;
  showLegend?: boolean;
  showLabels?: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  unit: '#4caf50',
  integration: '#2196f3',
  e2e: '#ff9800',
  acceptance: '#9c27b0',
};

const TYPE_LABELS: Record<string, string> = {
  unit: 'Unit',
  integration: 'Integration',
  e2e: 'E2E',
  acceptance: 'Acceptance',
};

export const TestTypeBreakdown: React.FC<TestTypeBreakdownProps> = ({
  byType,
  height = 8,
  showLegend = true,
  showLabels = false,
}) => {
  const total = Object.values(byType).reduce((sum, count) => sum + count, 0);

  if (total === 0) {
    return (
      <Box sx={{ width: '100%' }}>
        <Box
          sx={{
            width: '100%',
            height,
            bgcolor: 'action.disabledBackground',
            borderRadius: height / 2,
          }}
        />
        {showLegend && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
            No tests
          </Typography>
        )}
      </Box>
    );
  }

  const segments = Object.entries(byType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({
      type,
      count,
      percentage: (count / total) * 100,
      color: TYPE_COLORS[type] || '#757575',
      label: TYPE_LABELS[type] || type,
    }));

  return (
    <Box sx={{ width: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          width: '100%',
          height,
          borderRadius: height / 2,
          overflow: 'hidden',
        }}
      >
        {segments.map((segment, index) => (
          <Tooltip
            key={segment.type}
            title={`${segment.label}: ${segment.count} (${Math.round(segment.percentage)}%)`}
            arrow
          >
            <Box
              sx={{
                width: `${segment.percentage}%`,
                height: '100%',
                bgcolor: segment.color,
                transition: 'width 0.3s ease',
                cursor: 'default',
                '&:hover': {
                  opacity: 0.85,
                },
                ...(index === 0 && {
                  borderTopLeftRadius: height / 2,
                  borderBottomLeftRadius: height / 2,
                }),
                ...(index === segments.length - 1 && {
                  borderTopRightRadius: height / 2,
                  borderBottomRightRadius: height / 2,
                }),
              }}
            />
          </Tooltip>
        ))}
      </Box>

      {showLabels && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
          {segments.map(segment => (
            <Typography
              key={segment.type}
              variant="caption"
              sx={{
                color: segment.color,
                fontWeight: 500,
                fontSize: '0.65rem',
              }}
            >
              {segment.label}: {segment.count}
            </Typography>
          ))}
        </Stack>
      )}

      {showLegend && !showLabels && (
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          {segments.map(segment => (
            <Stack key={segment.type} direction="row" spacing={0.5} alignItems="center">
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: segment.color,
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {segment.label}: {segment.count}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
};

export const TestTypeBreakdownCompact: React.FC<{
  byType: TestTypeBreakdownProps['byType'];
}> = ({ byType }) => {
  const total = Object.values(byType).reduce((sum, count) => sum + count, 0);

  if (total === 0) return null;

  return (
    <Stack direction="row" spacing={0.5}>
      {Object.entries(byType)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => (
          <Tooltip
            key={type}
            title={`${TYPE_LABELS[type] || type}: ${count}`}
            arrow
          >
            <Box
              sx={{
                px: 0.75,
                py: 0.25,
                borderRadius: 1,
                bgcolor: TYPE_COLORS[type] || '#757575',
                color: 'white',
                fontSize: '0.7rem',
                fontWeight: 500,
              }}
            >
              {TYPE_LABELS[type]?.charAt(0) || type.charAt(0).toUpperCase()}: {count}
            </Box>
          </Tooltip>
        ))}
    </Stack>
  );
};

export default TestTypeBreakdown;
