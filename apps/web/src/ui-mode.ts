import { useCallback, useLayoutEffect, useState } from 'react';

export type UiDesign = 'classic' | 'next' | 'sidebar' | 'azure' | 'beacon';

const STORAGE_KEY = 'signal-atlas.ui';
/** Every selectable design. Keep in sync with the pre-paint script in index.html. */
export const UI_DESIGNS: readonly UiDesign[] = ['azure', 'beacon', 'sidebar', 'next', 'classic'];

function isDesign(value: string | null | undefined): value is UiDesign {
  return value === 'classic' || value === 'next' || value === 'sidebar' || value === 'azure' || value === 'beacon';
}

export function readUiDesign(): UiDesign {
  if (typeof window === 'undefined') return 'sidebar';
  try {
    const requested = new URLSearchParams(window.location.search).get('ui');
    if (isDesign(requested)) return requested;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isDesign(stored) ? stored : 'sidebar';
  } catch {
    return 'sidebar';
  }
}

/**
 * `data-ui` selects the visual theme, `data-layout` the shell geometry.
 * The two review designs (blue-gray, Beacon) keep the left-menu + page-tabs
 * layout but own a separate theme so the existing Signal Desk daylight theme
 * stays untouched.
 */
export function applyUiDesign(mode: UiDesign) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.ui =
    mode === 'classic' ? 'classic'
    : mode === 'azure' ? 'azure'
    : mode === 'beacon' ? 'beacon'
    : 'next';
  root.dataset.layout = mode === 'azure' || mode === 'beacon' ? 'sidebar' : mode;
}

export function useUiDesign() {
  const [mode, setModeState] = useState<UiDesign>(readUiDesign);
  const setMode = useCallback((next: UiDesign) => {
    applyUiDesign(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can reject storage; the in-memory choice still applies.
    }
    setModeState(next);
  }, []);
  useLayoutEffect(() => { applyUiDesign(mode); }, [mode]);
  return [mode, setMode] as const;
}
