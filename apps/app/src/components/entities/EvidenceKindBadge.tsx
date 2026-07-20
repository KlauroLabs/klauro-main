import { Chip, Tooltip } from '@mui/material';
import type { DataEntityKind } from '../../hooks/useEntities';

/**
 * `data_entities[].kind` is a deterministic structural fact — derived from
 * framework evidence, never from the entity's name (cas.types.ts
 * CASDataEntityKind doc comment). It answers "what KIND of evidence made
 * this a data entity": persisted by an ORM, a request DTO, an API response
 * shape, or a plain value object (POCO) with no persistence/route binding.
 * See docs/briefs/entities.md "Evidence kinds".
 */
const KIND_LABEL: Record<DataEntityKind, string> = {
  'persisted-entity': 'ORM',
  'request-dto': 'DTO',
  'api-response': 'Serialization',
  'value-object': 'POCO',
};

const KIND_DESCRIPTION: Record<DataEntityKind, string> = {
  'persisted-entity': 'Backed by an ORM entity/model — has a schema and is written to a database.',
  'request-dto': 'An inbound request contract — @Body / validation DTO / request schema.',
  'api-response': 'A response shape returned across a boundary — the terminal, serialized form.',
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
