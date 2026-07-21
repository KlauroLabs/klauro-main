import { Box, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import type { CasNode } from '@/shared/hooks/useFileNodes';

const SOURCE_LABEL: Record<string, string> = {
  deterministic: 'Deterministic',
  ai: 'AI-written',
  manual: 'Manually written',
  reused: 'Reused from a similar node',
};

function formatSignature(node: CasNode): string | null {
  if (!node.signature) return null;
  const params = (node.signature.parameters ?? [])
    .map(p => `${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type}` : ''}`)
    .join(', ');
  const returns = node.signature.return_type ? `: ${node.signature.return_type}` : '';
  return `(${params})${returns}`;
}

export function NodeSummaryCard({ node }: { node: CasNode }) {
  const signature = formatSignature(node);
  const sourceLabel = node.description_source ? SOURCE_LABEL[node.description_source] : undefined;
  const badges = [
    node.metadata?.is_exported ? 'exported' : null,
    node.metadata?.is_async ? 'async' : null,
    node.metadata?.is_static ? 'static' : null,
    node.metadata?.access_modifier ? String(node.metadata.access_modifier) : null,
  ].filter((b): b is string => Boolean(b));

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h5" component="code" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
            {node.name}
          </Typography>
          <Chip size="small" variant="outlined" label={node.type} />
          {badges.map(b => <Chip key={b} size="small" label={b} />)}
        </Stack>

        {signature ? (
          <Typography variant="body2" component="code" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {signature}
          </Typography>
        ) : null}

        <Typography variant="body2" component="code" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {node.source?.file ?? 'unknown file'}
          {node.source?.line ? `:${node.source.line}${node.source.end_line && node.source.end_line !== node.source.line ? `-${node.source.end_line}` : ''}` : ''}
        </Typography>

        {node.qualified_name && node.qualified_name !== node.name ? (
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {node.qualified_name}
          </Typography>
        ) : null}

        {node.description ? (
          <Box>
            <Divider sx={{ my: 1 }} />
            <Typography variant="body2">{node.description}</Typography>
            {sourceLabel ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {sourceLabel}
              </Typography>
            ) : null}
          </Box>
        ) : null}

        {node.tags && node.tags.length > 0 ? (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {node.tags.map(tag => <Chip key={tag} size="small" variant="outlined" label={tag} />)}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}
