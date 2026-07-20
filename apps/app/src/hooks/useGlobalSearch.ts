import { useCallback, useEffect, useRef, useState } from 'react';

export interface GlobalSearchResult {
  id: string;
  kind: 'workspace' | 'project' | 'capability' | 'entity';
  label: string;
  href: string;
}

/**
 * UI-side affordance for the global search entry point (Figma "Home" screen,
 * node 1698-13626: "Search workspace, repositories, entities..." input with
 * a Cmd/Ctrl+K shortcut). No search backend exists yet for the web app —
 * see apps/app/docs/DESIGN-NOTES.md for the data-gap entry. `search()` is a
 * stub: it tracks the query and always resolves to no results. Swap its
 * body for a real API call once one exists; the hook's contract
 * (query/results/isSearching/search/inputRef) will not need to change.
 */
export function useGlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback((next: string) => {
    setQuery(next);
    // STUB: no /api/search endpoint exists yet. Wired for the UI affordance
    // now so the component contract is stable once one lands.
    setIsSearching(false);
    setResults([]);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return { query, results, isSearching, search, inputRef };
}
