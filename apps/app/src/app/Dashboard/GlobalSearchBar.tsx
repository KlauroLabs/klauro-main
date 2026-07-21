import { InputAdornment, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useGlobalSearch } from '@/shared/hooks/useGlobalSearch';

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
