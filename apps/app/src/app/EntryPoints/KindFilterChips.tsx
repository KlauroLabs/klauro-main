import { Chip, Stack } from '@mui/material';
import { EntryKindIcon } from '@/shared/components/EntryKindIcon';
import { KIND_META, type EntryKind } from '@/shared/components/entryPointKinds';
import type { FamilyCount } from '@/shared/hooks/useEntryPoints';

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
