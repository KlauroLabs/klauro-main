import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio,
  Chip,
  Typography,
  Alert,
  Autocomplete,
  Switch,
  FormGroup,
  Divider,
} from '@mui/material';
import {
  Business as BusinessIcon,
  Person as PersonIcon,
} from '@mui/icons-material';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useWorkspaceValidation } from '../../hooks/useWorkspaces';
import {
  CreateWorkspaceRequest,
  WorkspaceOwnerType,
  Organization,
} from '../../types/workspace.types';

interface WorkspaceCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  organizations?: Organization[];
}

export function WorkspaceCreate({
  open,
  onClose,
  onSuccess,
  organizations = [],
}: WorkspaceCreateProps) {
  const { createWorkspace, isLoading, error } = useWorkspace();
  const { validateWorkspaceName, validateWorkspaceDescription, validateTags } = useWorkspaceValidation();

  const [formData, setFormData] = useState<CreateWorkspaceRequest>({
    name: '',
    description: '',
    visibility: 'private',
    tags: [],
    settings: {},
  });

  const [workspaceType, setWorkspaceType] = useState<WorkspaceOwnerType>('user');
  const [selectedOrganization, setSelectedOrganization] = useState<Organization | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [tagInput, setTagInput] = useState<string>('');

  const handleInputChange = (field: keyof CreateWorkspaceRequest, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));

    // Clear related errors
    if (formErrors[field]) {
      setFormErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const handleSettingsChange = (setting: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      settings: {
        ...prev.settings!,
        [setting]: value,
      },
    }));
  };

  const handleNotificationChange = (notification: string, value: boolean) => {
    setFormData(prev => ({
      ...prev,
      settings: {
        ...prev.settings!,
        notifications: {
          ...prev.settings!.notifications,
          [notification]: value,
        },
      },
    }));
  };

  const handleAddTag = (newTag: string) => {
    if (newTag && !formData.tags?.includes(newTag)) {
      const updatedTags = [...(formData.tags || []), newTag];
      handleInputChange('tags', updatedTags);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const updatedTags = formData.tags?.filter(tag => tag !== tagToRemove) || [];
    handleInputChange('tags', updatedTags);
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    const nameError = validateWorkspaceName(formData.name);
    if (nameError) errors.name = nameError;

    const descriptionError = validateWorkspaceDescription(formData.description || '');
    if (descriptionError) errors.description = descriptionError;

    const tagsError = validateTags(formData.tags || []);
    if (tagsError) errors.tags = tagsError;

    if (workspaceType === 'organization' && !selectedOrganization) {
      errors.organization = 'Organization is required for organization workspaces';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    try {
      await createWorkspace(formData);
      onSuccess?.();
      onClose();

      // Reset form
      setFormData({
        name: '',
        description: '',
        visibility: 'private',
        tags: [],
        settings: {
          auto_analyze: true,
          retention_days: 365,
          notifications: {
            analysis_complete: true,
            analysis_failed: true,
            weekly_summary: false,
          },
        },
      });
      setFormErrors({});
    } catch (err) {
      // Error handling is done by the context
    }
  };

  const handleClose = () => {
    if (!isLoading) {
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { minHeight: 600 } }}
    >
      <DialogTitle>Create New Workspace</DialogTitle>

      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={3}>
          {error && (
            <Alert severity="error">{error}</Alert>
          )}

          <TextField
            label="Workspace Name"
            value={formData.name}
            onChange={(e) => handleInputChange('name', e.target.value)}
            error={!!formErrors.name}
            helperText={formErrors.name}
            fullWidth
            required
            disabled={isLoading}
          />

          <TextField
            label="Description"
            value={formData.description}
            onChange={(e) => handleInputChange('description', e.target.value)}
            error={!!formErrors.description}
            helperText={formErrors.description}
            fullWidth
            multiline
            rows={3}
            disabled={isLoading}
          />

          <FormControl component="fieldset">
            <FormLabel component="legend">Workspace Type</FormLabel>
            <RadioGroup
              value={workspaceType}
              onChange={(e) => setWorkspaceType(e.target.value as WorkspaceOwnerType)}
            >
              <FormControlLabel
                value="user"
                control={<Radio />}
                label={
                  <Box display="flex" alignItems="center" gap={1}>
                    <PersonIcon fontSize="small" />
                    <Box>
                      <Typography variant="body1">Personal</Typography>
                      <Typography variant="caption" color="text.secondary">
                        For individual projects and personal use
                      </Typography>
                    </Box>
                  </Box>
                }
                disabled={isLoading}
              />
              <FormControlLabel
                value="organization"
                control={<Radio />}
                label={
                  <Box display="flex" alignItems="center" gap={1}>
                    <BusinessIcon fontSize="small" />
                    <Box>
                      <Typography variant="body1">Organization</Typography>
                      <Typography variant="caption" color="text.secondary">
                        For team collaboration and shared projects
                      </Typography>
                    </Box>
                  </Box>
                }
                disabled={isLoading || organizations.length === 0}
              />
            </RadioGroup>
          </FormControl>

          {workspaceType === 'organization' && (
            <Autocomplete
              options={organizations}
              getOptionLabel={(option) => option.name}
              value={selectedOrganization}
              onChange={(_, value) => setSelectedOrganization(value)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Organization"
                  error={!!formErrors.organization}
                  helperText={formErrors.organization}
                  required
                />
              )}
              disabled={isLoading}
            />
          )}

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Tags
            </Typography>
            <Autocomplete
              multiple
              freeSolo
              options={[]}
              value={formData.tags || []}
              onChange={(_, value) => handleInputChange('tags', value)}
              inputValue={tagInput}
              onInputChange={(_, value) => setTagInput(value)}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    variant="outlined"
                    label={option}
                    {...getTagProps({ index })}
                    key={option}
                  />
                ))
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Add tags..."
                  error={!!formErrors.tags}
                  helperText={formErrors.tags}
                />
              )}
              disabled={isLoading}
            />
          </Box>

          <Divider />

          <Typography variant="h6">Settings</Typography>

          <FormControl component="fieldset">
            <FormLabel component="legend">Visibility</FormLabel>
            <RadioGroup
              value={formData.settings?.visibility || 'private'}
              onChange={(e) => handleSettingsChange('visibility', e.target.value)}
            >
              <FormControlLabel
                value="private"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body2">Private</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Only invited users can access
                    </Typography>
                  </Box>
                }
              />
              <FormControlLabel
                value="internal"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body2">Internal</Typography>
                    <Typography variant="caption" color="text.secondary">
                      All organization members can access
                    </Typography>
                  </Box>
                }
                disabled={workspaceType === 'user'}
              />
            </RadioGroup>
          </FormControl>

          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.auto_analyze || false}
                  onChange={(e) => handleSettingsChange('auto_analyze', e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">Auto-analyze new codebases</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Automatically run analysis when codebases are added
                  </Typography>
                </Box>
              }
            />
          </FormGroup>

          <Typography variant="subtitle2">Notifications</Typography>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.notifications?.analysis_complete || false}
                  onChange={(e) => handleNotificationChange('analysis_complete', e.target.checked)}
                />
              }
              label="Analysis completion"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.notifications?.analysis_failed || false}
                  onChange={(e) => handleNotificationChange('analysis_failed', e.target.checked)}
                />
              }
              label="Analysis failures"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.notifications?.weekly_summary || false}
                  onChange={(e) => handleNotificationChange('weekly_summary', e.target.checked)}
                />
              }
              label="Weekly summary"
            />
          </FormGroup>
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={isLoading || !formData.name.trim()}
        >
          {isLoading ? 'Creating...' : 'Create Workspace'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}