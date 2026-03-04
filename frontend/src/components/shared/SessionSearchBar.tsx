import { useState, useCallback, useRef, useEffect } from 'react';

interface Props {
  placeholder?: string;
  onSearch: (term: string) => void;
  matchCount?: number;
  totalCount?: number;
  debounceMs?: number;
}

export default function SessionSearchBar({
  placeholder = 'Search sessions...',
  onSearch,
  matchCount,
  totalCount,
  debounceMs = 150,
}: Props) {
  const [value, setValue] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(v.trim().toLowerCase()), debounceMs);
  }, [onSearch, debounceMs]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

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
