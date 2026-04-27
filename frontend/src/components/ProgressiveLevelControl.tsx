import React from 'react';
import {
  Box,
  Slider,
  Typography,
  Card,
  CardContent,
  Chip,
  Stack,
  Tooltip,
  IconButton,
  Collapse,
  Button,
} from '@mui/material';
import {
  Info as InfoIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Layers as LayersIcon,
  Speed as SpeedIcon,
  Architecture as ArchitectureIcon,
} from '@mui/icons-material';
import { ProgressiveLevel } from '../hooks/useCASAnalysisData';

interface ProgressiveLevelControlProps {
  currentLevel: number;
  onLevelChange: (level: number) => void;
  progressiveLevels?: {
    total_levels: number;
    level_definitions?: ProgressiveLevel[];
  };
  nodeCount?: number;
  technologies?: {
    languages?: Array<{ name: string; percentage: number }>;
    frameworks?: Array<{ name: string; confidence: number }>;
  };
}

const ProgressiveLevelControl: React.FC<ProgressiveLevelControlProps> = ({
  currentLevel,
  onLevelChange,
  progressiveLevels,
  nodeCount = 0,
  technologies,
}) => {
  const [expanded, setExpanded] = React.useState(false);

  const getCurrentLevelDefinition = (): ProgressiveLevel | undefined => {
    return progressiveLevels?.level_definitions?.find(
      (def) => def.level === currentLevel
    );
  };

  const currentLevelDef = getCurrentLevelDefinition();
  const maxLevel = progressiveLevels?.total_levels || 5;

  const getLevelColor = (level: number): string => {
    const colors = ['#4CAF50', '#8BC34A', '#FFC107', '#FF9800', '#F44336'];
    return colors[Math.min(level, colors.length - 1)];
  };

  return (
    <Card sx={{ mb: 2, background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(10px)' }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={2} mb={2}>
          <LayersIcon sx={{ color: '#00bcd4' }} />
          <Typography variant="h6" sx={{ flexGrow: 1, color: '#00bcd4' }}>
            Progressive Disclosure Control
          </Typography>
          <IconButton
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ color: '#fff' }}
          >
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Stack>

        <Box sx={{ mb: 3 }}>
          <Stack direction="row" alignItems="center" spacing={1} mb={1}>
            <Typography variant="body2" sx={{ color: '#aaa', minWidth: '60px' }}>
              Level {currentLevel}
            </Typography>
            {currentLevelDef && (
              <Chip
                label={currentLevelDef.name}
                size="small"
                sx={{
                  backgroundColor: getLevelColor(currentLevel),
                  color: '#fff',
                }}
              />
            )}
            <Typography variant="body2" sx={{ color: '#888', ml: 'auto' }}>
              {nodeCount} nodes visible
            </Typography>
          </Stack>

          <Slider
            value={currentLevel}
            onChange={(_, value) => onLevelChange(value as number)}
            min={0}
            max={maxLevel - 1}
            marks={progressiveLevels?.level_definitions?.map((def) => ({
              value: def.level,
              label: def.level.toString(),
            }))}
            step={1}
            sx={{
              '& .MuiSlider-thumb': {
                backgroundColor: getLevelColor(currentLevel),
              },
              '& .MuiSlider-track': {
                background: `linear-gradient(90deg, ${getLevelColor(0)}, ${getLevelColor(currentLevel)})`,
              },
            }}
          />
        </Box>

        <Collapse in={expanded}>
          {currentLevelDef && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" sx={{ color: '#00bcd4', mb: 1 }}>
                Current Level: {currentLevelDef.name}
              </Typography>
              <Typography variant="body2" sx={{ color: '#aaa', mb: 2 }}>
                {currentLevelDef.description}
              </Typography>

              <Stack direction="row" spacing={1} mb={2}>
                <Tooltip title="Time to understand">
                  <Chip
                    icon={<SpeedIcon />}
                    label={currentLevelDef.time_to_understand}
                    size="small"
                    variant="outlined"
                    sx={{ color: '#888', borderColor: '#555' }}
                  />
                </Tooltip>
                <Tooltip title="Nodes at this level">
                  <Chip
                    label={`${currentLevelDef.node_count} nodes`}
                    size="small"
                    variant="outlined"
                    sx={{ color: '#888', borderColor: '#555' }}
                  />
                </Tooltip>
              </Stack>

              {currentLevelDef.recommended_for && (
                <>
                  <Typography variant="caption" sx={{ color: '#888' }}>
                    Recommended for:
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
                    {currentLevelDef.recommended_for.map((use) => (
                      <Chip
                        key={use}
                        label={use}
                        size="small"
                        sx={{
                          backgroundColor: 'rgba(0, 188, 212, 0.1)',
                          color: '#00bcd4',
                          border: '1px solid rgba(0, 188, 212, 0.3)',
                          mb: 0.5,
                        }}
                      />
                    ))}
                  </Stack>
                </>
              )}
            </Box>
          )}

          {progressiveLevels?.level_definitions && (
            <Box>
              <Typography variant="subtitle2" sx={{ color: '#00bcd4', mb: 2 }}>
                Available Levels
              </Typography>
              <Stack spacing={1}>
                {progressiveLevels.level_definitions.map((level) => (
                  <Button
                    key={level.level}
                    variant={level.level === currentLevel ? 'contained' : 'outlined'}
                    size="small"
                    onClick={() => onLevelChange(level.level)}
                    sx={{
                      justifyContent: 'space-between',
                      backgroundColor:
                        level.level === currentLevel
                          ? getLevelColor(level.level)
                          : 'transparent',
                      borderColor: getLevelColor(level.level),
                      color: level.level === currentLevel ? '#fff' : '#aaa',
                      '&:hover': {
                        backgroundColor:
                          level.level === currentLevel
                            ? getLevelColor(level.level)
                            : `${getLevelColor(level.level)}22`,
                      },
                    }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption">Level {level.level}</Typography>
                      <Typography variant="body2">{level.name}</Typography>
                    </Stack>
                    <Typography variant="caption" sx={{ opacity: 0.7 }}>
                      {level.node_count} nodes
                    </Typography>
                  </Button>
                ))}
              </Stack>
            </Box>
          )}

          {technologies && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" sx={{ color: '#00bcd4', mb: 1 }}>
                Technologies Detected
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap">
                {technologies.languages?.map((lang) => (
                  <Chip
                    key={lang.name}
                    label={`${lang.name} (${lang.percentage?.toFixed(1)}%)`}
                    size="small"
                    icon={<ArchitectureIcon />}
                    sx={{
                      backgroundColor: 'rgba(76, 175, 80, 0.1)',
                      color: '#4CAF50',
                      border: '1px solid rgba(76, 175, 80, 0.3)',
                      mb: 0.5,
                    }}
                  />
                ))}
                {technologies.frameworks?.map((fw) => (
                  <Chip
                    key={fw.name}
                    label={fw.name}
                    size="small"
                    sx={{
                      backgroundColor: 'rgba(255, 152, 0, 0.1)',
                      color: '#FF9800',
                      border: '1px solid rgba(255, 152, 0, 0.3)',
                      mb: 0.5,
                    }}
                  />
                ))}
              </Stack>
            </Box>
          )}
        </Collapse>

        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Tooltip title="Zoom out for overview">
            <Button
              size="small"
              variant="outlined"
              onClick={() => onLevelChange(0)}
              disabled={currentLevel === 0}
              sx={{ borderColor: '#555', color: '#aaa' }}
            >
              Overview
            </Button>
          </Tooltip>
          <Tooltip title="Show main components">
            <Button
              size="small"
              variant="outlined"
              onClick={() => onLevelChange(1)}
              disabled={currentLevel === 1}
              sx={{ borderColor: '#555', color: '#aaa' }}
            >
              Components
            </Button>
          </Tooltip>
          <Tooltip title="Deep dive into implementation">
            <Button
              size="small"
              variant="outlined"
              onClick={() => onLevelChange(Math.min(3, maxLevel - 1))}
              disabled={currentLevel >= 3}
              sx={{ borderColor: '#555', color: '#aaa' }}
            >
              Deep Dive
            </Button>
          </Tooltip>
        </Stack>
      </CardContent>
    </Card>
  );
};

export default ProgressiveLevelControl;
