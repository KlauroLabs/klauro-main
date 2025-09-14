import React, { useState } from 'react';
import {
  Paper,
  Typography,
  Box,
  IconButton,
  Tabs,
  Tab,
  Divider,
  Chip,
  List,
  ListItem,
  ListItemText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert
} from '@mui/material';
import {
  Close,
  ExpandMore,
  Storage,
  Code,
  Input,
  Output,
  Schedule,
  Security,
  DataObject
} from '@mui/icons-material';

interface ComponentDetails {
  id: string;
  name: string;
  description: string;
  type: string;
  
  // Code Details
  codeDetails: {
    filePath: string;
    language: string;
    linesOfCode: number;
    functions: Array<{
      name: string;
      parameters: string[];
      returnType: string;
      description: string;
    }>;
    variables: Array<{
      name: string;
      type: string;
      scope: 'global' | 'local' | 'class';
      value?: string;
    }>;
    classes: Array<{
      name: string;
      methods: string[];
      properties: string[];
    }>;
  };
  
  // Database Details
  databaseDetails?: {
    type: 'postgres' | 'mysql' | 'mongodb' | 'redis';
    connectionString: string;
    schemas: Array<{
      name: string;
      tables: Array<{
        name: string;
        columns: Array<{
          name: string;
          type: string;
          nullable: boolean;
          primaryKey?: boolean;
        }>;
      }>;
    }>;
    queries: string[];
  };
  
  // Message Queue Details
  messagingDetails?: {
    type: 'rabbitmq' | 'kafka' | 'sqs' | 'pubsub';
    publishers: Array<{
      topic: string;
      messageType: string;
      frequency: string;
    }>;
    subscribers: Array<{
      topic: string;
      handler: string;
    }>;
  };
  
  // Entry/Exit Points
  endpoints: {
    entry: Array<{
      type: 'http' | 'grpc' | 'websocket' | 'tcp';
      path: string;
      method?: string;
      parameters: string[];
      authentication?: string;
    }>;
    exit: Array<{
      type: 'http' | 'database' | 'message' | 'file';
      destination: string;
      protocol: string;
    }>;
  };
  
  // Data Flow
  dataFlow: {
    serializers: string[];
    validators: string[];
    transformers: string[];
    middleware: string[];
  };
  
  // Background Operations
  backgroundOps: Array<{
    name: string;
    type: 'cron' | 'queue' | 'event';
    schedule?: string;
    description: string;
  }>;
}

interface ComponentDetailsPanelProps {
  component: ComponentDetails | null;
  isOpen: boolean;
  onClose: () => void;
}

export const ComponentDetailsPanel: React.FC<ComponentDetailsPanelProps> = ({
  component,
  isOpen,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState(0);

  if (!isOpen || !component) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        top: 80,
        left: 16,
        width: 450,
        maxHeight: 'calc(100vh - 100px)',
        bgcolor: 'rgba(0, 8, 20, 0.95)',
        border: '2px solid #00bcd4',
        borderRadius: 1,
        zIndex: 1000,
        overflow: 'hidden'
      }}
    >
      {/* Header */}
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        p: 2,
        borderBottom: '1px solid #00bcd4',
        bgcolor: 'rgba(0, 188, 212, 0.1)'
      }}>
        <Box>
          <Typography variant="h6" sx={{ color: '#00bcd4', fontWeight: 'bold' }}>
            {component.name}
          </Typography>
          <Typography variant="caption" sx={{ color: '#aaa' }}>
            {component.type} • {component.codeDetails.filePath}
          </Typography>
        </Box>
        <IconButton onClick={onClose} sx={{ color: '#00bcd4' }}>
          <Close />
        </IconButton>
      </Box>

      {/* Description */}
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" sx={{ color: '#fff' }}>
          {component.description}
        </Typography>
      </Box>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={(_, newValue) => setActiveTab(newValue)}
        sx={{
          borderBottom: '1px solid #333',
          '& .MuiTab-root': { color: '#aaa', textTransform: 'none' },
          '& .Mui-selected': { color: '#00bcd4' }
        }}
      >
        <Tab label="Code" />
        <Tab label="I/O" />
        <Tab label="Data" />
        <Tab label="Background" />
      </Tabs>

      {/* Tab Content */}
      <Box sx={{ maxHeight: '400px', overflow: 'auto' }}>
        {/* Code Tab */}
        {activeTab === 0 && (
          <Box sx={{ p: 2 }}>
            {/* Functions */}
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMore sx={{ color: '#00bcd4' }} />}>
                <Typography sx={{ color: '#00bcd4', fontWeight: 'bold' }}>
                  Functions ({component.codeDetails.functions.length})
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                {component.codeDetails.functions.map(func => (
                  <Box key={func.name} sx={{ mb: 2, p: 1, bgcolor: 'rgba(255,255,255,0.05)', borderRadius: 1 }}>
                    <Typography variant="subtitle2" sx={{ color: '#4caf50', fontFamily: 'monospace' }}>
                      {func.name}({func.parameters.join(', ')}) → {func.returnType}
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#ccc', display: 'block', mt: 0.5 }}>
                      {func.description}
                    </Typography>
                  </Box>
                ))}
              </AccordionDetails>
            </Accordion>

            {/* Variables */}
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore sx={{ color: '#00bcd4' }} />}>
                <Typography sx={{ color: '#00bcd4', fontWeight: 'bold' }}>
                  Variables ({component.codeDetails.variables.length})
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ color: '#aaa' }}>Name</TableCell>
                      <TableCell sx={{ color: '#aaa' }}>Type</TableCell>
                      <TableCell sx={{ color: '#aaa' }}>Scope</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {component.codeDetails.variables.map(variable => (
                      <TableRow key={variable.name}>
                        <TableCell sx={{ color: '#ff9800', fontFamily: 'monospace' }}>{variable.name}</TableCell>
                        <TableCell sx={{ color: '#64b5f6' }}>{variable.type}</TableCell>
                        <TableCell>
                          <Chip 
                            label={variable.scope} 
                            size="small" 
                            sx={{ bgcolor: '#333', color: '#fff', fontSize: '10px' }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AccordionDetails>
            </Accordion>

            {/* Classes */}
            {component.codeDetails.classes.length > 0 && (
              <Accordion>
                <AccordionSummary expandIcon={<ExpandMore sx={{ color: '#00bcd4' }} />}>
                  <Typography sx={{ color: '#00bcd4', fontWeight: 'bold' }}>
                    Classes ({component.codeDetails.classes.length})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  {component.codeDetails.classes.map(cls => (
                    <Box key={cls.name} sx={{ mb: 2 }}>
                      <Typography variant="subtitle2" sx={{ color: '#e91e63', fontFamily: 'monospace' }}>
                        class {cls.name}
                      </Typography>
                      <Typography variant="caption" sx={{ color: '#ccc' }}>
                        Methods: {cls.methods.join(', ')}
                      </Typography>
                    </Box>
                  ))}
                </AccordionDetails>
              </Accordion>
            )}
          </Box>
        )}

        {/* I/O Tab */}
        {activeTab === 1 && (
          <Box sx={{ p: 2 }}>
            {/* Entry Points */}
            <Typography variant="subtitle1" sx={{ color: '#4caf50', mb: 1, display: 'flex', alignItems: 'center' }}>
              <Input sx={{ mr: 1 }} /> Entry Points
            </Typography>
            {component.endpoints.entry.map((entry, idx) => (
              <Box key={idx} sx={{ mb: 2, p: 1, bgcolor: 'rgba(76,175,80,0.1)', borderRadius: 1 }}>
                <Typography variant="body2" sx={{ color: '#4caf50', fontFamily: 'monospace' }}>
                  {entry.method} {entry.path}
                </Typography>
                <Typography variant="caption" sx={{ color: '#aaa' }}>
                  Type: {entry.type} • Auth: {entry.authentication || 'none'}
                </Typography>
                {entry.parameters.length > 0 && (
                  <Typography variant="caption" sx={{ color: '#aaa', display: 'block' }}>
                    Params: {entry.parameters.join(', ')}
                  </Typography>
                )}
              </Box>
            ))}

            <Divider sx={{ my: 2, bgcolor: '#333' }} />

            {/* Exit Points */}
            <Typography variant="subtitle1" sx={{ color: '#f44336', mb: 1, display: 'flex', alignItems: 'center' }}>
              <Output sx={{ mr: 1 }} /> Exit Points
            </Typography>
            {component.endpoints.exit.map((exit, idx) => (
              <Box key={idx} sx={{ mb: 2, p: 1, bgcolor: 'rgba(244,67,54,0.1)', borderRadius: 1 }}>
                <Typography variant="body2" sx={{ color: '#f44336', fontFamily: 'monospace' }}>
                  {exit.destination}
                </Typography>
                <Typography variant="caption" sx={{ color: '#aaa' }}>
                  {exit.type} • {exit.protocol}
                </Typography>
              </Box>
            ))}
          </Box>
        )}

        {/* Data Tab */}
        {activeTab === 2 && (
          <Box sx={{ p: 2 }}>
            {/* Database Details */}
            {component.databaseDetails && (
              <Accordion defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMore sx={{ color: '#00bcd4' }} />}>
                  <Typography sx={{ color: '#00bcd4', fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>
                    <Storage sx={{ mr: 1 }} /> 
                    Database ({component.databaseDetails.type.toUpperCase()})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Typography variant="caption" sx={{ color: '#aaa', fontFamily: 'monospace', display: 'block', mb: 1 }}>
                    {component.databaseDetails.connectionString}
                  </Typography>
                  
                  {component.databaseDetails.schemas.map(schema => (
                    <Box key={schema.name} sx={{ mb: 2 }}>
                      <Typography variant="subtitle2" sx={{ color: '#ff9800' }}>
                        Schema: {schema.name}
                      </Typography>
                      {schema.tables.map(table => (
                        <Box key={table.name} sx={{ ml: 2, mb: 1 }}>
                          <Typography variant="body2" sx={{ color: '#64b5f6' }}>
                            {table.name} ({table.columns.length} columns)
                          </Typography>
                          <Typography variant="caption" sx={{ color: '#ccc', display: 'block' }}>
                            {table.columns.map(col => 
                              `${col.name}:${col.type}${col.primaryKey ? '*' : ''}${col.nullable ? '?' : ''}`
                            ).join(', ')}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  ))}
                </AccordionDetails>
              </Accordion>
            )}

            {/* Message Queue */}
            {component.messagingDetails && (
              <Accordion>
                <AccordionSummary expandIcon={<ExpandMore sx={{ color: '#00bcd4' }} />}>
                  <Typography sx={{ color: '#00bcd4', fontWeight: 'bold' }}>
                    Messaging ({component.messagingDetails.type.toUpperCase()})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Typography variant="subtitle2" sx={{ color: '#4caf50', mb: 1 }}>Publishers</Typography>
                  {component.messagingDetails.publishers.map((pub, idx) => (
                    <Typography key={idx} variant="caption" sx={{ color: '#ccc', display: 'block' }}>
                      → {pub.topic} ({pub.messageType}) • {pub.frequency}
                    </Typography>
                  ))}
                  
                  <Typography variant="subtitle2" sx={{ color: '#f44336', mt: 2, mb: 1 }}>Subscribers</Typography>
                  {component.messagingDetails.subscribers.map((sub, idx) => (
                    <Typography key={idx} variant="caption" sx={{ color: '#ccc', display: 'block' }}>
                      ← {sub.topic} → {sub.handler}
                    </Typography>
                  ))}
                </AccordionDetails>
              </Accordion>
            )}

            {/* Data Flow */}
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMore sx={{ color: '#00bcd4' }} />}>
                <Typography sx={{ color: '#00bcd4', fontWeight: 'bold' }}>
                  Data Processing Pipeline
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                {['serializers', 'validators', 'transformers', 'middleware'].map(type => (
                  <Box key={type} sx={{ mb: 1 }}>
                    <Typography variant="caption" sx={{ color: '#ff9800', textTransform: 'capitalize' }}>
                      {type}:
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#ccc', ml: 1 }}>
                      {component.dataFlow[type as keyof typeof component.dataFlow].join(', ') || 'None'}
                    </Typography>
                  </Box>
                ))}
              </AccordionDetails>
            </Accordion>
          </Box>
        )}

        {/* Background Tab */}
        {activeTab === 3 && (
          <Box sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ color: '#ff9800', mb: 2, display: 'flex', alignItems: 'center' }}>
              <Schedule sx={{ mr: 1 }} /> Background Operations
            </Typography>
            
            {component.backgroundOps.length === 0 ? (
              <Typography variant="body2" sx={{ color: '#aaa' }}>
                No background operations detected
              </Typography>
            ) : (
              component.backgroundOps.map((op, idx) => (
                <Box key={idx} sx={{ mb: 2, p: 1, bgcolor: 'rgba(255,152,0,0.1)', borderRadius: 1 }}>
                  <Typography variant="body2" sx={{ color: '#ff9800', fontWeight: 'bold' }}>
                    {op.name}
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#aaa', display: 'block' }}>
                    Type: {op.type} {op.schedule && `• Schedule: ${op.schedule}`}
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#ccc' }}>
                    {op.description}
                  </Typography>
                </Box>
              ))
            )}
          </Box>
        )}
      </Box>
    </Paper>
  );
};