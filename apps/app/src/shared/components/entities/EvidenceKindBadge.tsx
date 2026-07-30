import { Chip, Tooltip } from '@mui/material';
import type { DataEntityKind } from '@/shared/hooks/useEntities';

const KIND_LABEL: Record<DataEntityKind, string> = {
  'persisted-entity': 'ORM',
  'request-dto': 'DTO',
  'api-response': 'Serialization',
  'domain-shape': 'Domain shape',
  'value-object': 'POCO',
};

const KIND_DESCRIPTION: Record<DataEntityKind, string> = {
  'persisted-entity': 'Backed by an ORM entity/model — has a schema and is written to a database.',
  'request-dto': 'An inbound request contract — @Body / validation DTO / request schema.',
  'api-response': 'A response shape returned across a boundary — the terminal, serialized form.',
  'domain-shape': 'A domain type with no persistence evidence — no ORM mapping, migration, or repository — so it carries no table and is not part of the ERD.',
  'value-object': 'A field-only shape with no persistence and no route/API binding.',
};

export function EvidenceKindBadge({ kind }: { kind: DataEntityKind | undefined }) {
  if (!kind) {
    return (
      <Tooltip title="No framework evidence classified this entity's kind yet.">
        <Chip size="small" variant="outlined" label="Unclassified" />
      </Tooltip>
    );
  }
  return (
    <Tooltip title={KIND_DESCRIPTION[kind]}>
      <Chip size="small" variant="outlined" label={KIND_LABEL[kind]} />
    </Tooltip>
  );
}
