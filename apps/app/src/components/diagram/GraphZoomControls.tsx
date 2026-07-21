import { Stack, Tooltip, Typography } from '@mui/material';
import NearMeOutlined from '@mui/icons-material/NearMeOutlined';
import GridViewOutlined from '@mui/icons-material/GridViewOutlined';
import RemoveCircleOutlined from '@mui/icons-material/RemoveCircleOutlined';
import AddCircleOutlined from '@mui/icons-material/AddCircleOutlined';

/** The zoom-control row shape SystemMapCard originally shipped as decorative
 *  ("Select — not yet interactive"). Extracted from GraphCanvas.tsx so every
 *  real diagram in the app shares the exact same functional row: pan hint,
 *  reset-to-fit, zoom out, percentage readout, zoom in. */
export function GraphZoomControls({
  zoom,
  onZoomChange,
  onReset,
}: {
  zoom: number;
  onZoomChange: (next: number) => void;
  onReset: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', justifyContent: 'center', border: 1, borderColor: 'divider', borderRadius: 5, py: 0.5, px: 1, width: 'fit-content', mx: 'auto' }}
    >
      <Tooltip title="Pan (drag the canvas)">
        <NearMeOutlined fontSize="small" sx={{ color: 'text.disabled' }} />
      </Tooltip>
      <Tooltip title="Reset view">
        <GridViewOutlined fontSize="small" sx={{ color: 'text.secondary', cursor: 'pointer' }} onClick={onReset} />
      </Tooltip>
      <Tooltip title="Zoom out">
        <RemoveCircleOutlined fontSize="small" sx={{ color: 'text.secondary', cursor: 'pointer' }} onClick={() => onZoomChange(zoom - 0.1)} />
      </Tooltip>
      <Typography variant="caption" color="text.disabled" sx={{ width: 36, textAlign: 'center' }}>
        {Math.round(zoom * 100)}%
      </Typography>
      <Tooltip title="Zoom in">
        <AddCircleOutlined fontSize="small" sx={{ color: 'text.secondary', cursor: 'pointer' }} onClick={() => onZoomChange(zoom + 0.1)} />
      </Tooltip>
    </Stack>
  );
}
