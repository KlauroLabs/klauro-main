import { useCallback, useEffect, useRef, useState } from 'react';

export interface GlobalSearchResult {
  id: string;
  kind: 'workspace' | 'project' | 'capability' | 'entity';
  label: string;
  href: string;
}

export function useGlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback((next: string) => {
    setQuery(next);

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
