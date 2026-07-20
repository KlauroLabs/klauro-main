import { Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { DataEntityField, DatabaseField } from '../../hooks/useEntities';

/**
 * Fields, per the brief's "name/type/sensitivity" — plus PK/FK/nullable/
 * unique when the ORM view (database_schema) has a matching field, since
 * that structural detail is real and free once an entity is joined there.
 */
export function EntityFieldsTable({
  fields,
  databaseFields,
}: {
  fields: DataEntityField[];
  databaseFields?: DatabaseField[];
}) {
  if (fields.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No fields recorded for this entity.
      </Typography>
    );
  }

  const dbFieldByName = new Map((databaseFields ?? []).map(f => [f.name, f]));

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Field</TableCell>
          <TableCell>Type</TableCell>
          <TableCell>Sensitivity</TableCell>
          <TableCell>Constraints</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {fields.map(field => {
          const dbField = dbFieldByName.get(field.name);
          const constraints = [
            dbField?.primary ? 'primary key' : null,
            dbField?.unique ? 'unique' : null,
            dbField?.nullable === false ? 'required' : null,
          ].filter(Boolean);
          return (
            <TableRow key={field.name}>
              <TableCell>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{field.name}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" component="code" sx={{ fontFamily: 'monospace' }}>{field.type}</Typography>
              </TableCell>
              <TableCell>
                {field.is_sensitive ? (
                  <Chip size="small" color="error" variant="outlined" label="Sensitive" />
                ) : (
                  <Typography variant="body2" color="text.secondary">—</Typography>
                )}
              </TableCell>
              <TableCell>
                {constraints.length > 0 ? (
                  <Typography variant="caption" color="text.secondary">{constraints.join(', ')}</Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary">—</Typography>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
