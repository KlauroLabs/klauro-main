import { InputAdornment, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useGlobalSearch } from '../../hooks/useGlobalSearch';

/**
 * Figma "Home" (node 1698-13626): the global search entry point —
 * "Search workspace, repositories, entities..." with a ⌘K shortcut hint.
 * No search backend exists yet (see apps/app/docs/DESIGN-NOTES.md); this is
 * the UI affordance + a stub hook (useGlobalSearch) so the contract is
 * stable once one lands. The ⌘K/Ctrl+K shortcut itself is real — it focuses
 * this field from anywhere on the page.
 */
export function GlobalSearchBar() {
  const { query, search, inputRef } = useGlobalSearch();
  return (
    <TextField
      fullWidth
      inputRef={inputRef}
      placeholder="Search workspace, repositories, entities…"
      value={query}
      onChange={e => search(e.target.value)}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: (
            <InputAdornment position="end">
              <Typography
                variant="caption"
                sx={{ color: 'primary.main', border: 1, borderColor: 'divider', borderRadius: 0.5, px: 0.5, py: 0.25 }}
              >
                ⌘K
              </Typography>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
