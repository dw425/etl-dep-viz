import { useState, useCallback } from 'react';

interface Props {
  placeholder?: string;
  onSearch: (term: string) => void;
  matchCount?: number;
  totalCount?: number;
  debounceMs?: number;
}

export default function SessionSearchBar({
  placeholder = 'Search sessions... (Enter to search)',
  onSearch,
  matchCount,
  totalCount,
}: Props) {
  const [value, setValue] = useState('');

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    if (v === '') onSearch('');
  }, [onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSearch(value.trim().toLowerCase());
    } else if (e.key === 'Escape') {
      setValue('');
      onSearch('');
      (e.target as HTMLInputElement).blur();
    }
  }, [onSearch, value]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      <div style={{ position: 'relative', flex: 1 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8899aa" strokeWidth="2"
          style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}>
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={{
            width: '100%',
            padding: '6px 8px 6px 28px',
            fontSize: 12,
            border: '1px solid #3a4a5e',
            borderRadius: 6,
            background: '#243044',
            color: '#e2e8f0',
            outline: 'none',
          }}
        />
      </div>
      {matchCount !== undefined && value && (
        <span style={{ fontSize: 10, color: '#8899aa', whiteSpace: 'nowrap' }}>
          {matchCount}{totalCount !== undefined ? `/${totalCount}` : ''} match{matchCount !== 1 ? 'es' : ''}
        </span>
      )}
    </div>
  );
}
