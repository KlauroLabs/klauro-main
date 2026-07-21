import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useAttachProject } from '@/shared/hooks/useAttachProject';

export interface AttachProjectDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  currentMemberProjectIds: string[];
}

export function AttachProjectDialog({ open, onClose, workspaceId, currentMemberProjectIds }: AttachProjectDialogProps) {
  const workspacesQuery = useWorkspaces();
  const attach = useAttachProject();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const data = workspacesQuery.data;
    if (!data) return [];
    const memberSet = new Set(currentMemberProjectIds);
    return Object.entries(data.projectsByWorkspace)
      .flatMap(([sourceWorkspaceId, projects]) =>
        projects
          .filter(project => !memberSet.has(project.id))
          .map(project => ({ project, sourceWorkspaceName: data.workspaces.find(w => w.id === sourceWorkspaceId)?.name ?? sourceWorkspaceId })),
      );
  }, [workspacesQuery.data, currentMemberProjectIds]);

  const selectedFromOtherWorkspace = candidates.find(c => c.project.id === selectedProjectId)?.sourceWorkspaceName;

  function handleClose() {
    setSelectedProjectId(null);
    attach.reset();
    onClose();
  }

  function handleAttach() {
    if (!selectedProjectId) return;
    attach.mutate({ workspaceId, projectId: selectedProjectId }, { onSuccess: handleClose });
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Add a repository</DialogTitle>
      <DialogContent>
        {selectedFromOtherWorkspace ? (
          <Alert severity="info" sx={{ mb: 2 }}>
            This project belongs to &ldquo;{selectedFromOtherWorkspace}&rdquo; — attaching it here moves it out of that workspace.
          </Alert>
        ) : null}
        {attach.isError ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {attach.error instanceof Error ? attach.error.message : 'Could not attach that project.'}
          </Alert>
        ) : null}
        {candidates.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No other projects on your account to attach.
          </Typography>
        ) : (
          <List dense>
            {candidates.map(({ project, sourceWorkspaceName }) => (
              <ListItemButton
                key={project.id}
                selected={selectedProjectId === project.id}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <ListItemText primary={project.name} secondary={`Currently in ${sourceWorkspaceName}`} />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="contained" disabled={!selectedProjectId || attach.isPending} onClick={handleAttach}>
          {attach.isPending ? 'Attaching…' : 'Attach'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
