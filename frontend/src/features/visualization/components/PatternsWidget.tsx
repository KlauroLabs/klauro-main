import React, { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Stack,
  Chip,
  IconButton,
  Collapse,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  LinearProgress,
  Alert,
  Divider,
} from '@mui/material';
import {
  Pattern,
  Warning,
  Error as ErrorIcon,
  Info,
  ExpandMore,
  ExpandLess,
  CheckCircle,
  Code,
  BugReport,
} from '@mui/icons-material';
import { CASPattern, CASPatternVariation, CASPatternDeviation, CASNode } from '../types';

export interface PatternsWidgetProps {
  patterns: CASPattern[];
  nodes: CASNode[];
  onPatternClick?: (patternId: string) => void;
  onNodeClick?: (nodeId: string) => void;
  onViewAll?: () => void;
}

const SEVERITY_COLORS: Record<string, 'info' | 'warning' | 'error'> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
};

export const PatternsWidget: React.FC<PatternsWidgetProps> = ({
  patterns,
  nodes,
  onPatternClick,
  onNodeClick,
  onViewAll,
}) => {
  const [expandedPattern, setExpandedPattern] = useState<string | null>(null);

  const designPatterns = patterns.filter(p => !p.id.includes('anti-pattern'));
  const antiPatterns = patterns.filter(p => p.id.includes('anti-pattern'));

  const allDeviations = patterns.flatMap(p =>
    (p.deviations || []).map(d => ({ ...d, patternId: p.id, patternName: p.name }))
  );

  const criticalDeviations = allDeviations.filter(d => d.severity === 'error');
  const warningDeviations = allDeviations.filter(d => d.severity === 'warning');

  const getNodeName = (nodeId: string): string => {
    const node = nodes.find(n => n.id === nodeId);
    return node?.name || nodeId.split('_').pop() || nodeId;
  };

  const togglePattern = (patternId: string) => {
    setExpandedPattern(prev => prev === patternId ? null : patternId);
  };

  if (patterns.length === 0) {
    return (
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Pattern fontSize="small" color="action" />
          <Typography variant="subtitle2" fontWeight={600}>Patterns</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          No patterns detected
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper sx={{ overflow: 'hidden' }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center">
            <Pattern fontSize="small" color="primary" />
            <Typography variant="subtitle2" fontWeight={600}>Patterns</Typography>
          </Stack>
          {onViewAll && (
            <Chip
              label="View All"
              size="small"
              onClick={onViewAll}
              sx={{ height: 20, fontSize: '0.7rem', cursor: 'pointer' }}
            />
          )}
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Chip
            icon={<CheckCircle sx={{ fontSize: 14 }} />}
            label={`${designPatterns.length} Patterns`}
            size="small"
            color="primary"
            variant="outlined"
            sx={{ height: 24, fontSize: '0.7rem' }}
          />
          {antiPatterns.length > 0 && (
            <Chip
              icon={<BugReport sx={{ fontSize: 14 }} />}
              label={`${antiPatterns.length} Anti-Patterns`}
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 24, fontSize: '0.7rem' }}
            />
          )}
          {criticalDeviations.length > 0 && (
            <Chip
              icon={<ErrorIcon sx={{ fontSize: 14 }} />}
              label={`${criticalDeviations.length} Critical`}
              size="small"
              color="error"
              sx={{ height: 24, fontSize: '0.7rem' }}
            />
          )}
          {warningDeviations.length > 0 && (
            <Chip
              icon={<Warning sx={{ fontSize: 14 }} />}
              label={`${warningDeviations.length} Warnings`}
              size="small"
              color="warning"
              sx={{ height: 24, fontSize: '0.7rem' }}
            />
          )}
        </Stack>
      </Box>

      {(criticalDeviations.length > 0 || warningDeviations.length > 0) && (
        <Box sx={{ px: 2, py: 1.5, bgcolor: 'action.hover' }}>
          <Typography variant="caption" fontWeight={600} color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            Deviations Requiring Attention
          </Typography>
          <Stack spacing={1}>
            {criticalDeviations.slice(0, 2).map((deviation, idx) => (
              <Alert
                key={`critical-${idx}`}
                severity="error"
                sx={{ py: 0.5, '& .MuiAlert-message': { py: 0 } }}
              >
                <Typography variant="caption" fontWeight={600}>
                  {deviation.patternName}
                </Typography>
                <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
                  {deviation.description.length > 80
                    ? deviation.description.slice(0, 80) + '...'
                    : deviation.description}
                </Typography>
              </Alert>
            ))}
            {warningDeviations.slice(0, criticalDeviations.length > 0 ? 1 : 2).map((deviation, idx) => (
              <Alert
                key={`warning-${idx}`}
                severity="warning"
                sx={{ py: 0.5, '& .MuiAlert-message': { py: 0 } }}
              >
                <Typography variant="caption" fontWeight={600}>
                  {deviation.patternName}
                </Typography>
                <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
                  {deviation.description.length > 80
                    ? deviation.description.slice(0, 80) + '...'
                    : deviation.description}
                </Typography>
              </Alert>
            ))}
          </Stack>
        </Box>
      )}

      <List dense disablePadding sx={{ maxHeight: 300, overflow: 'auto' }}>
        {patterns.slice(0, 6).map(pattern => {
          const isAntiPattern = pattern.id.includes('anti-pattern');
          const isExpanded = expandedPattern === pattern.id;
          const hasVariations = pattern.variations && pattern.variations.length > 0;
          const hasDeviations = pattern.deviations && pattern.deviations.length > 0;

          return (
            <React.Fragment key={pattern.id}>
              <ListItemButton
                onClick={() => togglePattern(pattern.id)}
                sx={{ py: 1 }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  {isAntiPattern ? (
                    <Warning fontSize="small" color="warning" />
                  ) : (
                    <Pattern fontSize="small" color="primary" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2" fontWeight={500}>
                        {pattern.name}
                      </Typography>
                      <Chip
                        label={`${pattern.instances.length}`}
                        size="small"
                        sx={{ height: 18, fontSize: '0.65rem', minWidth: 24 }}
                      />
                      {hasDeviations && (
                        <Warning sx={{ fontSize: 14, color: 'warning.main' }} />
                      )}
                    </Stack>
                  }
                  secondary={
                    hasVariations && (
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                        {pattern.variations!.slice(0, 3).map(v => (
                          <Chip
                            key={v.id}
                            label={`${v.percentage}% ${v.implementation.replace(/-/g, ' ')}`}
                            size="small"
                            variant="outlined"
                            sx={{ height: 16, fontSize: '0.6rem' }}
                          />
                        ))}
                      </Stack>
                    )
                  }
                />
                {isExpanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
              </ListItemButton>

              <Collapse in={isExpanded}>
                <Box sx={{ pl: 5, pr: 2, pb: 1.5, bgcolor: 'action.hover' }}>
                  {hasVariations && (
                    <Box sx={{ mb: 1.5 }}>
                      <Typography variant="caption" color="text.secondary" fontWeight={600}>
                        Implementation Breakdown
                      </Typography>
                      {pattern.variations!.map(variation => (
                        <Box key={variation.id} sx={{ mt: 0.5 }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography variant="caption">
                              {variation.implementation.replace(/-/g, ' ')}
                            </Typography>
                            <Typography variant="caption" fontWeight={600}>
                              {variation.percentage}%
                            </Typography>
                          </Stack>
                          <LinearProgress
                            variant="determinate"
                            value={variation.percentage}
                            sx={{
                              height: 4,
                              borderRadius: 2,
                              bgcolor: 'action.selected',
                              '& .MuiLinearProgress-bar': {
                                borderRadius: 2,
                                bgcolor: variation.percentage > 50 ? 'primary.main' : 'warning.main',
                              },
                            }}
                          />
                          <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 0.5 }}>
                            {variation.instances.slice(0, 5).map(instanceId => (
                              <Chip
                                key={instanceId}
                                icon={<Code sx={{ fontSize: 10 }} />}
                                label={getNodeName(instanceId)}
                                size="small"
                                variant="outlined"
                                onClick={() => onNodeClick?.(instanceId)}
                                sx={{
                                  height: 18,
                                  fontSize: '0.6rem',
                                  cursor: onNodeClick ? 'pointer' : 'default',
                                  '& .MuiChip-icon': { ml: 0.5 },
                                }}
                              />
                            ))}
                            {variation.instances.length > 5 && (
                              <Chip
                                label={`+${variation.instances.length - 5}`}
                                size="small"
                                sx={{ height: 18, fontSize: '0.6rem' }}
                              />
                            )}
                          </Stack>
                        </Box>
                      ))}
                    </Box>
                  )}

                  {hasDeviations && (
                    <Box>
                      <Typography variant="caption" color="text.secondary" fontWeight={600}>
                        Deviations
                      </Typography>
                      <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                        {pattern.deviations!.map((deviation, idx) => (
                          <Alert
                            key={idx}
                            severity={SEVERITY_COLORS[deviation.severity]}
                            sx={{ py: 0, '& .MuiAlert-message': { py: 0.5 } }}
                          >
                            <Typography variant="caption" display="block">
                              {deviation.description}
                            </Typography>
                            {deviation.recommendation && (
                              <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                                {deviation.recommendation}
                              </Typography>
                            )}
                          </Alert>
                        ))}
                      </Stack>
                    </Box>
                  )}

                  {!hasVariations && !hasDeviations && (
                    <Stack direction="row" flexWrap="wrap" gap={0.5}>
                      {pattern.instances.slice(0, 8).map(instanceId => (
                        <Chip
                          key={instanceId}
                          icon={<Code sx={{ fontSize: 10 }} />}
                          label={getNodeName(instanceId)}
                          size="small"
                          variant="outlined"
                          onClick={() => onNodeClick?.(instanceId)}
                          sx={{
                            height: 18,
                            fontSize: '0.6rem',
                            cursor: onNodeClick ? 'pointer' : 'default',
                            '& .MuiChip-icon': { ml: 0.5 },
                          }}
                        />
                      ))}
                      {pattern.instances.length > 8 && (
                        <Chip
                          label={`+${pattern.instances.length - 8}`}
                          size="small"
                          sx={{ height: 18, fontSize: '0.6rem' }}
                        />
                      )}
                    </Stack>
                  )}
                </Box>
              </Collapse>
              <Divider />
            </React.Fragment>
          );
        })}
      </List>

      {patterns.length > 6 && (
        <Box sx={{ p: 1, textAlign: 'center', borderTop: 1, borderColor: 'divider' }}>
          <Chip
            label={`View all ${patterns.length} patterns`}
            size="small"
            onClick={onViewAll}
            sx={{ cursor: 'pointer' }}
          />
        </Box>
      )}
    </Paper>
  );
};
