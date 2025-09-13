import React, { useState } from 'react';
import {
  Box,
  Paper,
  IconButton,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tooltip,
  Chip,
  Divider,
  Typography,
  Popover,
  List,
  ListItem,
  ListItemText,
  Switch,
  FormControlLabel
} from '@mui/material';
import {
  ZoomIn,
  ZoomOut,
  CenterFocusStrong,
  Search,
  FilterList,
  Download,
  Settings,
  WifiTethering,
  WifiTetheringOff,
  Layers,
  Palette
} from '@mui/icons-material';

interface GraphControlsProps {
  zoom: number;
  layout: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  onLayoutChange: (layout: string) => void;
  onSearch: (query: string) => void;
  onFilter: (filters: any) => void;
  onExport: (format: 'svg' | 'png' | 'pdf') => void;
  isConnected?: boolean;
  nodeCount?: number;
  edgeCount?: number;
}

const GraphControls: React.FC<GraphControlsProps> = ({
  zoom,
  layout,
  onZoomIn,
  onZoomOut,
  onResetView,
  onLayoutChange,
  onSearch,
  onFilter,
  onExport,
  isConnected = false,
  nodeCount = 0,
  edgeCount = 0
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterAnchor, setFilterAnchor] = useState<HTMLButtonElement | null>(null);
  const [exportAnchor, setExportAnchor] = useState<HTMLButtonElement | null>(null);
  const [filters, setFilters] = useState({
    showOrphaned: true,
    showCritical: true,
    minConnections: 0,
    componentTypes: [] as string[]
  });

  const layouts = [
    { value: 'force', label: 'Force-Directed' },
    { value: 'hierarchical', label: 'Hierarchical' },
    { value: 'circular', label: 'Circular' },
    { value: 'grid', label: 'Grid' },
    { value: 'dagre', label: 'Dagre' },
    { value: 'radial', label: 'Radial' }
  ];

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchQuery);
  };

  const handleFilterChange = (key: string, value: any) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    onFilter(newFilters);
  };

  return (
    <Paper 
      elevation={2}
      sx={{ 
        p: 1, 
        mb: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'wrap'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Tooltip title="Zoom In">
          <IconButton onClick={onZoomIn} size="small">
            <ZoomIn />
          </IconButton>
        </Tooltip>
        
        <Typography variant="body2" sx={{ minWidth: 50, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </Typography>
        
        <Tooltip title="Zoom Out">
          <IconButton onClick={onZoomOut} size="small">
            <ZoomOut />
          </IconButton>
        </Tooltip>
        
        <Tooltip title="Reset View">
          <IconButton onClick={onResetView} size="small">
            <CenterFocusStrong />
          </IconButton>
        </Tooltip>
      </Box>
      
      <Divider orientation="vertical" flexItem />
      
      <FormControl size="small" sx={{ minWidth: 140 }}>
        <InputLabel>Layout</InputLabel>
        <Select
          value={layout}
          onChange={(e) => onLayoutChange(e.target.value)}
          label="Layout"
          startAdornment={<Layers sx={{ mr: 1, fontSize: 20 }} />}
        >
          {layouts.map(l => (
            <MenuItem key={l.value} value={l.value}>
              {l.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      
      <Divider orientation="vertical" flexItem />
      
      <Box 
        component="form" 
        onSubmit={handleSearchSubmit}
        sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
      >
        <TextField
          size="small"
          placeholder="Search components..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          sx={{ width: 200 }}
          InputProps={{
            startAdornment: <Search sx={{ mr: 1, fontSize: 20, color: 'text.secondary' }} />
          }}
        />
      </Box>
      
      <Tooltip title="Filters">
        <IconButton 
          onClick={(e) => setFilterAnchor(e.currentTarget)}
          size="small"
          color={Object.keys(filters).some(k => filters[k as keyof typeof filters]) ? 'primary' : 'default'}
        >
          <FilterList />
        </IconButton>
      </Tooltip>
      
      <Popover
        open={Boolean(filterAnchor)}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ p: 2, minWidth: 250 }}>
          <Typography variant="subtitle2" sx={{ mb: 2 }}>
            Filter Options
          </Typography>
          
          <List dense>
            <ListItem>
              <FormControlLabel
                control={
                  <Switch
                    checked={filters.showOrphaned}
                    onChange={(e) => handleFilterChange('showOrphaned', e.target.checked)}
                  />
                }
                label="Show Orphaned"
              />
            </ListItem>
            
            <ListItem>
              <FormControlLabel
                control={
                  <Switch
                    checked={filters.showCritical}
                    onChange={(e) => handleFilterChange('showCritical', e.target.checked)}
                  />
                }
                label="Show Critical"
              />
            </ListItem>
            
            <ListItem>
              <TextField
                size="small"
                type="number"
                label="Min Connections"
                value={filters.minConnections}
                onChange={(e) => handleFilterChange('minConnections', parseInt(e.target.value))}
                fullWidth
              />
            </ListItem>
          </List>
        </Box>
      </Popover>
      
      <Divider orientation="vertical" flexItem />
      
      <Button
        size="small"
        startIcon={<Download />}
        onClick={(e) => setExportAnchor(e.currentTarget)}
      >
        Export
      </Button>
      
      <Popover
        open={Boolean(exportAnchor)}
        anchorEl={exportAnchor}
        onClose={() => setExportAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <List>
          <ListItem button onClick={() => { onExport('svg'); setExportAnchor(null); }}>
            <ListItemText primary="Export as SVG" secondary="Vector format" />
          </ListItem>
          <ListItem button onClick={() => { onExport('png'); setExportAnchor(null); }}>
            <ListItemText primary="Export as PNG" secondary="Image format" />
          </ListItem>
          <ListItem button onClick={() => { onExport('pdf'); setExportAnchor(null); }}>
            <ListItemText primary="Export as PDF" secondary="Document format" />
          </ListItem>
        </List>
      </Popover>
      
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip
          size="small"
          label={`${nodeCount} nodes`}
          variant="outlined"
        />
        <Chip
          size="small"
          label={`${edgeCount} edges`}
          variant="outlined"
        />
        <Chip
          size="small"
          icon={isConnected ? <WifiTethering /> : <WifiTetheringOff />}
          label={isConnected ? 'Live' : 'Offline'}
          color={isConnected ? 'success' : 'default'}
          variant={isConnected ? 'filled' : 'outlined'}
        />
      </Box>
    </Paper>
  );
};

export default GraphControls;