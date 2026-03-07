/**
 * useCommitSearch — search input that only commits (triggers filtering)
 * on Enter key press, not on every keystroke. Avoids re-filtering 14K+
 * items on each character typed.
 *
 * Usage:
 *   const { inputValue, committedValue, inputProps, clear } = useCommitSearch();
 *   // Bind inputProps to <input {...inputProps} />
 *   // Use committedValue for filtering (only updates on Enter)
 */
import { useState, useCallback, useMemo } from 'react';

interface UseCommitSearchResult {
  /** Current text in the input (updates on every keystroke for display). */
  inputValue: string;
  /** The committed search term (updates only on Enter or clear). */
  committedValue: string;
  /** Props to spread onto an <input> element. */
  inputProps: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  };
  /** Clear both input and committed value. */
  clear: () => void;
  /** Programmatically commit the current input value. */
  commit: () => void;
}

export function useCommitSearch(initial = ''): UseCommitSearchResult {
  const [inputValue, setInputValue] = useState(initial);
  const [committedValue, setCommittedValue] = useState(initial);

  const commit = useCallback(() => {
    setCommittedValue(inputValue);
  }, [inputValue]);

  const clear = useCallback(() => {
    setInputValue('');
    setCommittedValue('');
  }, []);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInputValue(v);
    // Auto-clear filter when input is emptied (backspace to empty)
    if (v === '') setCommittedValue('');
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      setCommittedValue(inputValue);
    } else if (e.key === 'Escape') {
      setInputValue('');
      setCommittedValue('');
      (e.target as HTMLInputElement).blur();
    }
  }, [inputValue]);

  const inputProps = useMemo(() => ({ value: inputValue, onChange, onKeyDown }), [inputValue, onChange, onKeyDown]);

  return { inputValue, committedValue, inputProps, clear, commit };
}
