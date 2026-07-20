import { Chip, Stack } from '@mui/material';
import { EntryKindIcon } from '../../components/EntryKindIcon';
import { KIND_META, type EntryKind } from '../../components/entryPointKinds';
import type { FamilyCount } from '../../hooks/useEntryPoints';

/**
 * The fixed kind vocabulary, scoped to what this deployable actually has —
 * "the three families hold a fixed, complete set of kinds... any one
 * deployable uses a handful; the rest simply read as zero" (brief). Only
 * kinds with count > 0 render; nothing here is ever a surprise because the
 * vocabulary itself (entryPointKinds.ts) is the complete, fixed list.
 */
export interface KindFilterChipsProps {
  familyCounts: FamilyCount[];
  selected: EntryKind | null;
  onSelect: (kind: EntryKind | null) => void;
}

export function KindFilterChips({ familyCounts, selected, onSelect }: KindFilterChipsProps) {
  const kinds = familyCounts.flatMap(f => f.kinds);
  if (kinds.length === 0) return null;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {kinds.map(({ kind, count }) => (
        <Chip
          key={kind}
          size="small"
          variant={selected === kind ? 'filled' : 'outlined'}
          color={selected === kind ? 'primary' : 'default'}
          icon={<EntryKindIcon kind={kind} size={14} accent={selected === kind} />}
          label={`${KIND_META[kind].label} (${count})`}
          onClick={() => onSelect(selected === kind ? null : kind)}
        />
      ))}
    </Stack>
  );
}
