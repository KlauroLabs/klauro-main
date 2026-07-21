import { useNavigate } from 'react-router-dom';
import { Chip, List, ListItemButton, ListItemText, Typography } from '@mui/material';
import type { DatabaseRelationship } from '@/shared/hooks/useEntities';
import { encodeSlug } from '@/shared/lib/slugs';

const TYPE_LABEL: Record<string, string> = {
  OneToOne: '1 — 1',
  OneToMany: '1 — N',
  ManyToOne: 'N — 1',
  ManyToMany: 'N — N',
};

export function EntityRelationshipsList({
  relationships,
  projectId,
  entityIdByNameLower,
}: {
  relationships: DatabaseRelationship[];
  projectId: string;

  entityIdByNameLower: Map<string, { id: string; name: string }>;
}) {
  const navigate = useNavigate();

  if (relationships.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No ORM relations found for this entity — it stands alone in the schema, or its relations are declared on the other side.
      </Typography>
    );
  }

  return (
    <List disablePadding>
      {relationships.map((rel, index) => {
        const target = entityIdByNameLower.get(rel.target.toLowerCase());
        return (
          <ListItemButton
            key={`${rel.target}-${rel.field}-${index}`}
            disabled={!target}
            onClick={() => target && navigate(`/codebases/${projectId}/entities/${encodeSlug(target)}`)}
            sx={{ borderBottom: '1px solid', borderColor: 'divider', px: 0 }}
          >
            <ListItemText
              primary={`${rel.field} → ${rel.target}`}
              secondary={rel.join_table ? `via ${rel.join_table}` : rel.inverse_field ? `inverse: ${rel.inverse_field}` : undefined}
            />
            <Chip size="small" variant="outlined" label={TYPE_LABEL[rel.type] ?? rel.type} />
          </ListItemButton>
        );
      })}
    </List>
  );
}
