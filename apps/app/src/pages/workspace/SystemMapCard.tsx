// "System Map" card (Figma node 1748:6595, frame "Group 288" / "Frame
// 1597881764" title+subtitle + node/arrow diagram + zoom-control row "Frame
// 1597881791"). The Figma mock lays nodes out at fixed x/y canvas
// coordinates; the WAS graph carries no layout coordinates for
// runtime_components, so a pixel-faithful spatial diagram isn't data-driven
// buildable. Built instead as: the exact card shell (title, subtitle, zoom
// control row) with the node set shown as a wrapped row of labeled chips and
// the edges (runtime_links) as a compact "A -> B" relationship list below —
// this is the "runtime_links as first-class relationship list" requirement,
// housed inside the one designed element that represents system topology
// rather than as a second, undesigned section. See DESIGN-NOTES.md.
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import NearMeOutlined from '@mui/icons-material/NearMeOutlined';
import GridViewOutlined from '@mui/icons-material/GridViewOutlined';
import RemoveCircleOutlined from '@mui/icons-material/RemoveCircleOutlined';
import AddCircleOutlined from '@mui/icons-material/AddCircleOutlined';
import ArrowRightAltIcon from '@mui/icons-material/ArrowRightAlt';
import { EmptyState } from '../../layout/EmptyState';
import type { WorkspaceRuntimeComponent, WorkspaceRuntimeLink } from '../../api';

export interface SystemMapCardProps {
  components: WorkspaceRuntimeComponent[];
  links: WorkspaceRuntimeLink[];
}

export function SystemMapCard({ components, links }: SystemMapCardProps) {
  const nameById = new Map(components.map(component => [component.id, component.name]));

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 4, height: '100%' }}>
      <Stack spacing={3} sx={{ height: '100%' }}>
        <Stack spacing={0.5}>
          <Typography variant="h6" component="h2">
            System Map
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Visual overview of your system architecture
          </Typography>
        </Stack>

        {components.length === 0 ? (
          <EmptyState title="No runtime topology detected yet" description="Runtime components appear here once member codebases expose them." />
        ) : (
          <Stack spacing={2.5} sx={{ flexGrow: 1 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {components.map(component => (
                <Chip key={component.id} variant="outlined" label={component.name} />
              ))}
            </Stack>
            {links.length === 0 ? (
              <Typography variant="caption" color="text.disabled">
                No relationships observed between these components yet.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {links.map(link => (
                  <Stack key={link.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="body2">{nameById.get(link.source_component_id) ?? link.source_component_id}</Typography>
                    <ArrowRightAltIcon fontSize="small" sx={{ color: 'text.disabled' }} />
                    <Typography variant="body2">{nameById.get(link.target_component_id) ?? link.target_component_id}</Typography>
                    {link.kind ? (
                      <Chip size="small" variant="outlined" label={link.kind} sx={{ height: 20, fontSize: 10 }} />
                    ) : null}
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        )}

        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', justifyContent: 'center', border: 1, borderColor: 'divider', borderRadius: 5, py: 0.5, px: 1, width: 'fit-content', mx: 'auto' }}
        >
          <Tooltip title="Select (not yet interactive)">
            <NearMeOutlined fontSize="small" sx={{ color: 'text.disabled' }} />
          </Tooltip>
          <GridViewOutlined fontSize="small" sx={{ color: 'text.disabled' }} />
          <RemoveCircleOutlined fontSize="small" sx={{ color: 'text.disabled' }} />
          <Typography variant="caption" color="text.disabled">100%</Typography>
          <AddCircleOutlined fontSize="small" sx={{ color: 'text.disabled' }} />
        </Stack>
      </Stack>
    </Box>
  );
}
