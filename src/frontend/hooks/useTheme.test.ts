import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTheme } from './useTheme';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('toggles the dark class on <html> and persists the choice', () => {
    const { result } = renderHook(() => useTheme());
    const initial = result.current.theme;

    act(() => result.current.toggle());

    expect(result.current.theme).not.toBe(initial);
    expect(document.documentElement.classList.contains('dark')).toBe(result.current.theme === 'dark');
    expect(localStorage.getItem('tnc.theme')).toBe(result.current.theme);
  });

  it('reads a previously stored preference on mount', () => {
    localStorage.setItem('tnc.theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
