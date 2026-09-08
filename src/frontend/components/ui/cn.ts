import clsx, { type ClassValue } from 'clsx';

/** Thin wrapper kept as its own module so every component imports the same helper. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
