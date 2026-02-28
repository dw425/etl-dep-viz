/**
 * useUrlState — syncs view state with URL query parameters for deep linking.
 *
 * Supports: ?view=tier&upload=123&layer=3&session=S1&search=text
 * Updates URL without page reload using history.replaceState.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface UrlState {
  view?: string;
  upload?: string;
  layer?: string;
  session?: string;
  search?: string;
  chunk?: string;
}

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
