import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  Typography,
  Alert,
  Autocomplete,
  Switch,
  FormGroup,
  FormControlLabel,
  Divider,
  Chip,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormHelperText,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import {
  GitHub as GitHubIcon,
  Link as LinkIcon,
  Folder as FolderIcon,
  CloudUpload as CloudUploadIcon,
} from '@mui/icons-material';
import { useCodebases, useCodebaseValidation } from '../../hooks/useCodebases';
import { CreateCodebaseRequest } from '../../types/workspace.types';

export enum CodebaseSourceType {
  REPOSITORY_URL = 'repository_url',
  LOCAL_PATH = 'local_path',
  UPLOAD = 'upload',
}

interface CodebaseCreateProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  workspaceId: string;
}

export function CodebaseCreate({
  open,
  onClose,
  onSuccess,
  workspaceId,
}: CodebaseCreateProps) {
  const { createCodebase } = useCodebases(workspaceId);
  const {
    validateCodebaseName,
    validateRepositoryUrl,
    validateDescription,
    validateTags,
  } = useCodebaseValidation();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<CodebaseSourceType>(CodebaseSourceType.REPOSITORY_URL);

  const [formData, setFormData] = useState<CreateCodebaseRequest>({
    name: '',
    description: '',
    repositoryUrl: '',
    localPath: '',
    sourceType: CodebaseSourceType.REPOSITORY_URL,
    defaultBranch: 'main',
    settings: {
      autoAnalyze: true,
      analysisSchedule: '',
      ignorePatterns: [
        'node_modules/**',
        '.git/**',
        '*.min.js',
        '*.bundle.js',
        'dist/**',
        'build/**',
        '*.log',
        '.env*',
      ],
      includePatterns: [],
      maxFileSizeMb: 10,
      notifications: {
        analysisComplete: true,
        analysisFailed: true,
        issuesDetected: false,
      },
    },
  });

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const handleInputChange = (field: keyof CreateCodebaseRequest, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));

    // Clear related errors
    if (formErrors[field]) {
      setFormErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }

    // Auto-generate name from repository URL if name is empty
    if (field === 'repositoryUrl' && !formData.name && value) {
      try {
        const url = new URL(value);
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const repoName = pathParts[pathParts.length - 1].replace(/\.git$/, '');
          setFormData(prev => ({ ...prev, name: repoName }));
        }
      } catch {
        // Invalid URL, ignore
      }
    }

    // Auto-generate name from local path if name is empty
    if (field === 'localPath' && !formData.name && value) {
      const pathParts = value.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const dirName = pathParts[pathParts.length - 1];
        setFormData(prev => ({ ...prev, name: dirName }));
      }
    }
  };

  const handleSourceTypeChange = (newType: CodebaseSourceType) => {
    setSourceType(newType);
    setFormData(prev => ({ ...prev, sourceType: newType }));
    setFormErrors({});
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

  const handlePatternsChange = (type: 'ignorePatterns' | 'includePatterns', patterns: string[]) => {
    setFormData(prev => ({
      ...prev,
      settings: {
        ...prev.settings!,
        [type]: patterns,
      },
    }));
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    const nameError = validateCodebaseName(formData.name);
    if (nameError) errors.name = nameError;

    if (sourceType === CodebaseSourceType.REPOSITORY_URL) {
      const urlError = validateRepositoryUrl(formData.repositoryUrl || '');
      if (urlError) errors.repositoryUrl = urlError;
    } else if (sourceType === CodebaseSourceType.LOCAL_PATH) {
      if (!formData.localPath || formData.localPath.trim().length === 0) {
        errors.localPath = 'Local path is required';
      }
    }

    const descriptionError = validateDescription(formData.description || '');
    if (descriptionError) errors.description = descriptionError;

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    try {
      setIsLoading(true);
      setError(null);
      await createCodebase(formData);
      onSuccess?.();
      onClose();

      // Reset form
      setFormData({
        name: '',
        description: '',
        repositoryUrl: '',
        localPath: '',
        sourceType: CodebaseSourceType.REPOSITORY_URL,
        defaultBranch: 'main',
        settings: {
          autoAnalyze: true,
          analysisSchedule: '',
          ignorePatterns: [
            'node_modules/**',
            '.git/**',
            '*.min.js',
            '*.bundle.js',
            'dist/**',
            'build/**',
            '*.log',
            '.env*',
          ],
          includePatterns: [],
          maxFileSizeMb: 10,
          notifications: {
            analysisComplete: true,
            analysisFailed: true,
            issuesDetected: false,
          },
        },
      });
      setFormErrors({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create codebase');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    if (!isLoading) {
      onClose();
    }
  };

  const getRepositoryIcon = () => {
    if (sourceType === CodebaseSourceType.LOCAL_PATH) {
      return <FolderIcon fontSize="small" />;
    }
    if (sourceType === CodebaseSourceType.UPLOAD) {
      return <CloudUploadIcon fontSize="small" />;
    }
    if (formData.repositoryUrl?.includes('github.com')) {
      return <GitHubIcon fontSize="small" />;
    }
    if (formData.repositoryUrl) {
      return <LinkIcon fontSize="small" />;
    }
    return <LinkIcon fontSize="small" />;
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { minHeight: 700 } }}
    >
      <DialogTitle>Add New Codebase</DialogTitle>

      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={3}>
          {error && (
            <Alert severity="error">{error}</Alert>
          )}

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Source Type
            </Typography>
            <ToggleButtonGroup
              value={sourceType}
              exclusive
              onChange={(_, value) => value && handleSourceTypeChange(value)}
              fullWidth
              size="small"
            >
              <ToggleButton value={CodebaseSourceType.REPOSITORY_URL}>
                <LinkIcon sx={{ mr: 1 }} fontSize="small" />
                Repository URL
              </ToggleButton>
              <ToggleButton value={CodebaseSourceType.LOCAL_PATH}>
                <FolderIcon sx={{ mr: 1 }} fontSize="small" />
                Local Path
              </ToggleButton>
              <ToggleButton value={CodebaseSourceType.UPLOAD} disabled>
                <CloudUploadIcon sx={{ mr: 1 }} fontSize="small" />
                Upload (Coming Soon)
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box display="flex" gap={2}>
            <TextField
              label="Codebase Name"
              value={formData.name}
              onChange={(e) => handleInputChange('name', e.target.value)}
              error={!!formErrors.name}
              helperText={formErrors.name}
              fullWidth
              required
              disabled={isLoading}
            />

            <Box display="flex" alignItems="center" minWidth={40}>
              {getRepositoryIcon()}
            </Box>
          </Box>

          {sourceType === CodebaseSourceType.REPOSITORY_URL && (
            <>
              <TextField
                label="Repository URL"
                value={formData.repositoryUrl}
                onChange={(e) => handleInputChange('repositoryUrl', e.target.value)}
                error={!!formErrors.repositoryUrl}
                helperText={formErrors.repositoryUrl || 'Link to your Git repository for automatic updates'}
                fullWidth
                required
                disabled={isLoading}
                placeholder="https://github.com/username/repository"
              />

              {formData.repositoryUrl && (
                <TextField
                  label="Branch"
                  value={formData.defaultBranch}
                  onChange={(e) => handleInputChange('defaultBranch', e.target.value)}
                  fullWidth
                  disabled={isLoading}
                  placeholder="main"
                />
              )}
            </>
          )}

          {sourceType === CodebaseSourceType.LOCAL_PATH && (
            <TextField
              label="Local Filesystem Path"
              value={formData.localPath}
              onChange={(e) => handleInputChange('localPath', e.target.value)}
              error={!!formErrors.localPath}
              helperText={formErrors.localPath || 'Absolute path to the codebase directory on your local machine (for testing)'}
              fullWidth
              required
              disabled={isLoading}
              placeholder="/Users/username/projects/my-app"
            />
          )}

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
            placeholder="Describe what this codebase contains..."
          />

          {/* Tags removed - not in current backend schema */}

          <Divider />

          <Typography variant="h6">Analysis Settings</Typography>

          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.autoAnalyze || false}
                  onChange={(e) => handleSettingsChange('autoAnalyze', e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">Auto-analyze on changes</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Automatically run analysis when repository is updated
                  </Typography>
                </Box>
              }
            />
          </FormGroup>

          <FormControl fullWidth>
            <InputLabel>Analysis Schedule</InputLabel>
            <Select
              value={formData.settings?.analysisSchedule || ''}
              label="Analysis Schedule"
              onChange={(e) => handleSettingsChange('analysisSchedule', e.target.value)}
            >
              <MenuItem value="">Manual only</MenuItem>
              <MenuItem value="daily">Daily</MenuItem>
              <MenuItem value="weekly">Weekly</MenuItem>
              <MenuItem value="monthly">Monthly</MenuItem>
            </Select>
            <FormHelperText>
              Schedule automatic analysis runs
            </FormHelperText>
          </FormControl>

          <TextField
            label="Max File Size (MB)"
            type="number"
            value={formData.settings?.maxFileSizeMb || 10}
            onChange={(e) => handleSettingsChange('maxFileSizeMb', parseInt(e.target.value) || 10)}
            InputProps={{ inputProps: { min: 1, max: 100 } }}
            helperText="Files larger than this will be skipped during analysis"
            fullWidth
          />

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Ignore Patterns
            </Typography>
            <Autocomplete
              multiple
              freeSolo
              options={[
                'node_modules/**',
                '.git/**',
                '*.min.js',
                '*.bundle.js',
                'dist/**',
                'build/**',
                'target/**',
                '*.log',
                '.env*',
                '**/*.test.js',
                '**/*.spec.js',
                'coverage/**',
              ]}
              value={formData.settings?.ignorePatterns || []}
              onChange={(_, value) => handlePatternsChange('ignorePatterns', value)}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    variant="outlined"
                    label={option}
                    size="small"
                    {...getTagProps({ index })}
                    key={option}
                  />
                ))
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Add patterns to ignore during analysis..."
                  helperText="Use glob patterns to exclude files/directories"
                />
              )}
            />
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Include Patterns (Optional)
            </Typography>
            <Autocomplete
              multiple
              freeSolo
              options={[
                '**/*.js',
                '**/*.ts',
                '**/*.jsx',
                '**/*.tsx',
                '**/*.py',
                '**/*.java',
                '**/*.go',
                '**/*.rs',
                '**/*.cpp',
                '**/*.c',
              ]}
              value={formData.settings?.includePatterns || []}
              onChange={(_, value) => handlePatternsChange('includePatterns', value)}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    variant="outlined"
                    label={option}
                    size="small"
                    {...getTagProps({ index })}
                    key={option}
                  />
                ))
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Optionally specify patterns to include..."
                  helperText="If specified, only matching files will be analyzed"
                />
              )}
            />
          </Box>

          <Typography variant="subtitle2">Notifications</Typography>
          <FormGroup>
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.notifications.analysisComplete || false}
                  onChange={(e) => handleNotificationChange('analysisComplete', e.target.checked)}
                />
              }
              label="Analysis completion"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.notifications.analysisFailed || false}
                  onChange={(e) => handleNotificationChange('analysisFailed', e.target.checked)}
                />
              }
              label="Analysis failures"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={formData.settings?.notifications.issuesDetected || false}
                  onChange={(e) => handleNotificationChange('issuesDetected', e.target.checked)}
                />
              }
              label="Issues detected"
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
          {isLoading ? 'Adding...' : 'Add Codebase'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}