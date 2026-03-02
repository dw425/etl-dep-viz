/**
 * useUrlState — syncs view state with URL query parameters for deep linking.
 *
 * Supports: ?view=tier&upload=123&layer=3&session=S1&search=text
 * Updates URL without page reload using history.replaceState.
 */

import { useCallback, useEffect, useRef } from 'react';

/** Subset of app state that is reflected in URL query parameters for deep linking. */
export interface UrlState {
  /** Current view ID (e.g. "tier", "galaxy", "explorer"). */
  view?: string;
  /** Upload ID for restoring a specific dataset. */
  upload?: string;
  /** Layer number (1-6) for the progressive disclosure system. */
  layer?: string;
  /** Session ID for direct session navigation. */
  session?: string;
  /** Active search query text. */
  search?: string;
  /** Chunk selector state. */
  chunk?: string;
}

/** Reads the current URL query parameters and extracts known state keys. */
function parseUrlState(): UrlState {
  const params = new URLSearchParams(window.location.search);
  const state: UrlState = {};
  if (params.has('view')) state.view = params.get('view')!;
  if (params.has('upload')) state.upload = params.get('upload')!;
  if (params.has('layer')) state.layer = params.get('layer')!;
  if (params.has('session')) state.session = params.get('session')!;
  if (params.has('search')) state.search = params.get('search')!;
  if (params.has('chunk')) state.chunk = params.get('chunk')!;
  return state;
}

/** Constructs a URL string from a UrlState object. Returns bare pathname if no params. */
function buildUrl(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.view) params.set('view', state.view);
  if (state.upload) params.set('upload', state.upload);
  if (state.layer) params.set('layer', state.layer);
  if (state.session) params.set('session', state.session);
  if (state.search) params.set('search', state.search);
  if (state.chunk) params.set('chunk', state.chunk);
  const qs = params.toString();
  return qs ? `?${qs}` : window.location.pathname;
}

/**
 * Hook that syncs application state with URL query parameters for deep linking.
 * Reads initial state from the URL on mount and listens for popstate (back/forward).
 * Provides updateUrl() to push state changes to the URL without page reload.
 * @param onStateChange - Optional callback invoked when URL state changes via browser navigation
 */
export function useUrlState(
  onStateChange?: (state: UrlState) => void,
) {
  const initialState = useRef(parseUrlState());

  // Listen for browser back/forward
  useEffect(() => {
    const handler = () => {
      const state = parseUrlState();
      onStateChange?.(state);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [onStateChange]);

  const updateUrl = useCallback((state: UrlState) => {
    const url = buildUrl(state);
    window.history.replaceState(null, '', url);
  }, []);

  return {
    initialState: initialState.current,
    updateUrl,
  };
}
