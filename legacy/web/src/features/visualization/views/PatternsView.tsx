import React, { useMemo } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Chip,
  IconButton,
  Grid,
  Card,
  CardContent,
  CardActionArea,
} from '@mui/material';
import {
  ArrowBack,
  Warning,
  CheckCircle,
} from '@mui/icons-material';
import { CASPattern, CASNode } from '../types';

export interface PatternsViewProps {
  patterns: CASPattern[];
  nodes: CASNode[];
  onBack: () => void;
  onPatternSelect: (pattern: CASPattern) => void;
}

const MEANINGFUL_NODE_TYPES = new Set(['class', 'interface', 'controller', 'service', 'repository', 'guard', 'module', 'component', 'decorator']);

export const PatternsView: React.FC<PatternsViewProps> = ({
  patterns,
  nodes,
  onBack,
  onPatternSelect,
}) => {
  const { designPatterns, antiPatterns, totalDeviations } = useMemo(() => {
    const design = patterns.filter(p => !p.id.includes('anti-pattern'));
    const anti = patterns.filter(p => p.id.includes('anti-pattern'));
    const deviationCount = patterns.reduce((sum, p) => sum + (p.deviations?.length || 0), 0);
    return { designPatterns: design, antiPatterns: anti, totalDeviations: deviationCount };
  }, [patterns]);

  return (
    <Box sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 3, borderRadius: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <IconButton onClick={onBack} size="small">
            <ArrowBack />
          </IconButton>
          <Box>
            <Typography variant="h5" fontWeight={700}>
              Detected Patterns
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {designPatterns.length} design patterns, {antiPatterns.length} anti-patterns
              {totalDeviations > 0 && `, ${totalDeviations} issues found`}
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Box sx={{ p: 3 }}>
        {designPatterns.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
              Design Patterns
            </Typography>
            <Grid container spacing={2}>
              {designPatterns.map(pattern => (
                <Grid item xs={12} sm={6} md={4} key={pattern.id}>
                  <PatternCard
                    pattern={pattern}
                    nodes={nodes}
                    onClick={() => onPatternSelect(pattern)}
                  />
                </Grid>
              ))}
            </Grid>
          </Box>
        )}

        {antiPatterns.length > 0 && (
          <Box>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 2, color: 'warning.main' }}>
              Anti-Patterns Detected
            </Typography>
            <Grid container spacing={2}>
              {antiPatterns.map(pattern => (
                <Grid item xs={12} sm={6} md={4} key={pattern.id}>
                  <PatternCard
                    pattern={pattern}
                    nodes={nodes}
                    isAntiPattern
                    onClick={() => onPatternSelect(pattern)}
                  />
                </Grid>
              ))}
            </Grid>
          </Box>
        )}
      </Box>
    </Box>
  );
};

interface PatternCardProps {
  pattern: CASPattern;
  nodes: CASNode[];
  isAntiPattern?: boolean;
  onClick: () => void;
}

const PatternCard: React.FC<PatternCardProps> = ({ pattern, nodes, isAntiPattern, onClick }) => {
  const hasDeviations = pattern.deviations && pattern.deviations.length > 0;

  const implementations = useMemo(() => {
    return pattern.instances
      .map(id => nodes.find(n => n.id === id))
      .filter((n): n is CASNode => n !== undefined && MEANINGFUL_NODE_TYPES.has(n.type))
      .slice(0, 3);
  }, [pattern.instances, nodes]);

  const implementationCount = pattern.instances
    .map(id => nodes.find(n => n.id === id))
    .filter((n): n is CASNode => n !== undefined && MEANINGFUL_NODE_TYPES.has(n.type))
    .length;

  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        borderColor: isAntiPattern ? 'warning.main' : hasDeviations ? 'warning.light' : undefined,
        borderWidth: isAntiPattern ? 2 : 1,
      }}
    >
      <CardActionArea onClick={onClick} sx={{ height: '100%' }}>
        <CardContent>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            {isAntiPattern ? (
              <Warning color="warning" fontSize="small" />
            ) : hasDeviations ? (
              <Warning color="warning" fontSize="small" />
            ) : (
              <CheckCircle color="success" fontSize="small" />
            )}
            <Typography variant="subtitle1" fontWeight={600}>
              {pattern.name}
            </Typography>
          </Stack>

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mb: 2,
              minHeight: 40,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {pattern.description || 'No description available'}
          </Typography>

          <Typography variant="body2" fontWeight={500} sx={{ mb: 1 }}>
            {implementationCount} implementation{implementationCount !== 1 ? 's' : ''}
          </Typography>

          {implementations.length > 0 && (
            <Stack spacing={0.5}>
              {implementations.map(node => (
                <Typography key={node.id} variant="caption" color="text.secondary" noWrap>
                  {node.name}
                </Typography>
              ))}
              {implementationCount > 3 && (
                <Typography variant="caption" color="primary">
                  +{implementationCount - 3} more
                </Typography>
              )}
            </Stack>
          )}

          {hasDeviations && (
            <Chip
              icon={<Warning sx={{ fontSize: 14 }} />}
              label={`${pattern.deviations!.length} issue${pattern.deviations!.length !== 1 ? 's' : ''}`}
              size="small"
              color="warning"
              sx={{ mt: 2 }}
            />
          )}
        </CardContent>
      </CardActionArea>
    </Card>
  );
};
