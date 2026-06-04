import React from 'react';
import {
  Box,
  Typography,
  IconButton,
  Stack,
  Chip,
  Paper,
  Divider,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import {
  Close,
  Storage,
  Cloud,
  Code,
  Description,
} from '@mui/icons-material';
import { ExitPoint } from '../types';

export interface ExitPointDetailPanelProps {
  exitPoint: ExitPoint;
  sourceNodeName?: string;
  onClose: () => void;
}

export const ExitPointDetailPanel: React.FC<ExitPointDetailPanelProps> = ({
  exitPoint,
  sourceNodeName,
  onClose,
}) => {
  const getIcon = () => {
    switch (exitPoint.type) {
      case 'database':
        return <Storage sx={{ fontSize: 48, color: 'primary.main' }} />;
      case 'api':
        return <Cloud sx={{ fontSize: 48, color: 'info.main' }} />;
      default:
        return <Code sx={{ fontSize: 48, color: 'text.secondary' }} />;
    }
  };

  const getTypeColor = () => {
    switch (exitPoint.type) {
      case 'database':
        return 'primary.main';
      case 'api':
        return 'info.main';
      default:
        return 'text.secondary';
    }
  };

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
      }}
    >
      <Box
        sx={{
          p: 2,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="h6">Exit Point Details</Typography>
        <IconButton onClick={onClose} size="small">
          <Close />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
        <Stack spacing={3}>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            {getIcon()}
          </Box>

          <Box>
            <Typography variant="h5" gutterBottom textAlign="center">
              {exitPoint.name}
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, mt: 1 }}>
              <Chip
                label={exitPoint.type}
                size="small"
                sx={{
                  bgcolor: `${getTypeColor()}20`,
                  color: getTypeColor(),
                }}
              />
            </Box>
          </Box>

          {exitPoint.description && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Description
                </Typography>
                <Typography variant="body2">{exitPoint.description}</Typography>
              </Box>
            </>
          )}

          {sourceNodeName && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Called From
                </Typography>
                <Typography variant="body2" fontFamily="monospace">
                  {sourceNodeName}
                </Typography>
              </Box>
            </>
          )}

          {exitPoint.source && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Source Location
                </Typography>
                <Typography variant="body2" fontFamily="monospace">
                  {exitPoint.source.file}:{exitPoint.source.line}
                </Typography>
              </Box>
            </>
          )}

          {exitPoint.type === 'database' && exitPoint.target && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Database Target
                </Typography>
                <List dense>
                  {exitPoint.target.resource && (
                    <ListItem disablePadding>
                      <ListItemText
                        primary="Repository"
                        secondary={exitPoint.target.resource}
                        primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                        secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                      />
                    </ListItem>
                  )}
                  {exitPoint.target.system && (
                    <ListItem disablePadding>
                      <ListItemText
                        primary="System"
                        secondary={exitPoint.target.system}
                        primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                        secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                      />
                    </ListItem>
                  )}
                </List>
              </Box>
            </>
          )}

          {exitPoint.type === 'api' && exitPoint.target && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  API Target
                </Typography>
                <List dense>
                  {exitPoint.target.endpoint && (
                    <ListItem disablePadding>
                      <ListItemText
                        primary="Endpoint"
                        secondary={exitPoint.target.endpoint}
                        primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                        secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                      />
                    </ListItem>
                  )}
                  {exitPoint.target.protocol && (
                    <ListItem disablePadding>
                      <ListItemText
                        primary="Protocol"
                        secondary={exitPoint.target.protocol}
                        primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                        secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                      />
                    </ListItem>
                  )}
                </List>
              </Box>
            </>
          )}

          {exitPoint.operation && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Operation
                </Typography>
                <List dense>
                  <ListItem disablePadding>
                    <ListItemText
                      primary="Action"
                      secondary={exitPoint.operation.action}
                      primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                      secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                    />
                  </ListItem>
                  <ListItem disablePadding>
                    <ListItemText
                      primary="Async"
                      secondary={exitPoint.operation.async ? 'Yes' : 'No'}
                      primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                      secondaryTypographyProps={{ variant: 'body2' }}
                    />
                  </ListItem>
                </List>
              </Box>
            </>
          )}

          {exitPoint.operations && exitPoint.operations.length > 0 && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Operations
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {exitPoint.operations.map((op, idx) => (
                    <Chip key={idx} label={op} size="small" variant="outlined" />
                  ))}
                </Stack>
              </Box>
            </>
          )}

          {exitPoint.metadata && Object.keys(exitPoint.metadata).length > 0 && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Additional Metadata
                </Typography>
                <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }}>
                  <Typography variant="body2" fontFamily="monospace" component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {JSON.stringify(exitPoint.metadata, null, 2)}
                  </Typography>
                </Paper>
              </Box>
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
};
