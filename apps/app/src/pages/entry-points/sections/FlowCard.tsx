import { Box, Button, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useNavigate } from 'react-router-dom';
import type { FlowConcept } from '../../../api';

/**
 * The STARTING-SURFACE rule (brief): an entry point isn't the end of the
 * story, it's the beginning of a flow — the step from entry point into flow
 * matters as much as the catalog itself. This card is that deliberate step.
 */
export function FlowCard({ projectId, flow, isLoading }: { projectId: string; flow: FlowConcept | undefined; isLoading: boolean }) {
  const navigate = useNavigate();
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        The flow it opens
      </Typography>
      {isLoading ? (
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      ) : flow ? (
        <>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {flow.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {flow.intent}
          </Typography>
          <Button
            size="small"
            endIcon={<ArrowForwardIcon />}
            onClick={() => navigate(`/codebases/${projectId}/flows/${flow.flow_id}`)}
          >
            Follow it inward
          </Button>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No flow linked yet for this entry point.
        </Typography>
      )}
    </Box>
  );
}
