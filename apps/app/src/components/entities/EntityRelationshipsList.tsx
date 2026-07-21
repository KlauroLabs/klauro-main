import { useNavigate } from 'react-router-dom';
import { Chip, List, ListItemButton, ListItemText, Typography } from '@mui/material';
import type { DatabaseRelationship } from '../../hooks/useEntities';
import { encodeSlug } from '../../lib/slugs';

const TYPE_LABEL: Record<string, string> = {
  OneToOne: '1 — 1',
  OneToMany: '1 — N',
  ManyToOne: 'N — 1',
  ManyToMany: 'N — N',
};

/**
 * Evidence-gated relationships: every row here came from a real ORM
 * relation edge in database_schema — nothing guessed from a field name that
 * merely looks like a foreign key. Many entities have none; that's a real,
 * common shape (relationship sparsity), rendered as an honest empty state
 * rather than hidden.
 */
export function EntityRelationshipsList({
  relationships,
  projectId,
  entityIdByNameLower,
}: {
  relationships: DatabaseRelationship[];
  projectId: string;
  /** name(lowercased) -> {id, name} for every entity in this codebase — used
   *  both to gate navigation (relations to an entity the CAS didn't resolve
   *  simply aren't clickable) and to mint the target's canonical slug. */
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
