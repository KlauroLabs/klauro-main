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
  Typography,
  Alert,
  Autocomplete,
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
  const { validateWorkspaceName, validateWorkspaceDescription } = useWorkspaceValidation();

  const [formData, setFormData] = useState<CreateWorkspaceRequest>({
    name: '',
    slug: '',
    description: '',
    visibility: 'private',
    settings: {},
  });

  const [workspaceType, setWorkspaceType] = useState<WorkspaceOwnerType>('user');
  const [selectedOrganization, setSelectedOrganization] = useState<Organization | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const generateSlug = (name: string): string => {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  const handleInputChange = (field: keyof CreateWorkspaceRequest, value: any) => {
    setFormData(prev => {
      const updated = { ...prev, [field]: value };

      if (field === 'name' && typeof value === 'string') {
        updated.slug = generateSlug(value);
      }

      return updated;
    });

    if (formErrors[field]) {
      setFormErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };



  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    const nameError = validateWorkspaceName(formData.name);
    if (nameError) errors.name = nameError;

    const descriptionError = validateWorkspaceDescription(formData.description || '');
    if (descriptionError) errors.description = descriptionError;

    if (!formData.slug || formData.slug.length < 3) {
      errors.slug = 'Slug must be at least 3 characters';
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(formData.slug)) {
      errors.slug = 'Slug must be lowercase alphanumeric with hyphens';
    }

    if (workspaceType === 'organization' && !selectedOrganization) {
      errors.organization = 'Organization is required for organization workspaces';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    try {
      const payload = {
        name: formData.name,
        slug: formData.slug,
        description: formData.description,
        visibility: formData.visibility,
        settings: formData.settings,
      };

      await createWorkspace(payload);
      onSuccess?.();
      onClose();

      setFormData({
        name: '',
        slug: '',
        description: '',
        visibility: 'private',
        settings: {},
      });
      setFormErrors({});
    } catch (err) {
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
            helperText={formErrors.name || 'A descriptive name for your workspace'}
            fullWidth
            required
            disabled={isLoading}
          />

          <TextField
            label="Slug"
            value={formData.slug}
            onChange={(e) => handleInputChange('slug', e.target.value)}
            error={!!formErrors.slug}
            helperText={formErrors.slug || 'URL-friendly identifier (auto-generated from name)'}
            fullWidth
            required
            disabled={isLoading}
            placeholder="my-workspace-slug"
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

          <FormControl component="fieldset">
            <FormLabel component="legend">Visibility</FormLabel>
            <RadioGroup
              value={formData.visibility || 'private'}
              onChange={(e) => handleInputChange('visibility', e.target.value)}
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