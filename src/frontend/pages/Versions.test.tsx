import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FileVersion } from '../../shared';
import type * as ApiClientModule from '../lib/api-client';
import { formatAge, formatBytes, Versions } from './Versions';

const apiMock = vi.hoisted(() => vi.fn());

// Only `api` is replaced; `ApiError` and the rest stay real, so the page's
// `err instanceof ApiError` branches behave as they do in the browser.
vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../lib/api-client');
  return { ...actual, api: apiMock };
});

const NOW_SECONDS = 1_700_000_000;

function version(overrides: Partial<FileVersion> = {}): FileVersion {
  return {
    id: 1,
    shareId: 1,
    relPath: 'PGM/PART1.H',
    hash: 'abcdef0123456789'.repeat(4),
    size: 2048,
    mtime: NOW_SECONDS * 1000,
    origin: 'server',
    reason: null,
    createdAt: NOW_SECONDS,
    pinned: false,
    ...overrides,
  };
}

/** Routes each endpoint the page calls to a canned response. */
function mockApi(versions: FileVersion[]): void {
  apiMock.mockImplementation((endpoint: string) => {
    if (endpoint === 'versions.list') {
      return Promise.resolve({
        items: versions,
        total: versions.length,
        limit: 100,
        offset: 0,
      });
    }
    if (endpoint === 'config.get') {
      return Promise.resolve({ keepCount: 20, keepDays: 90, maxStoreGb: 10 });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('formatBytes', () => {
  it('uses plain bytes below a kilobyte', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('scales up through the units', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('formatAge', () => {
  const now = NOW_SECONDS * 1000;

  it('describes recent captures as just now', () => {
    expect(formatAge(NOW_SECONDS - 10, now)).toBe('just now');
  });

  it('steps through minutes, hours, days and months', () => {
    expect(formatAge(NOW_SECONDS - 300, now)).toBe('5 min ago');
    expect(formatAge(NOW_SECONDS - 7200, now)).toBe('2 h ago');
    expect(formatAge(NOW_SECONDS - 3 * 86_400, now)).toBe('3 d ago');
    expect(formatAge(NOW_SECONDS - 90 * 86_400, now)).toBe('3 mo ago');
  });

  it('never reports a negative age for a clock skew', () => {
    expect(formatAge(NOW_SECONDS + 500, now)).toBe('just now');
  });
});

describe('Versions page', () => {
  it('lists version history with origin and size', async () => {
    mockApi([
      version({ id: 2, origin: 'tnc', size: 4096, createdAt: NOW_SECONDS }),
      version({ id: 1, origin: 'server', size: 2048, createdAt: NOW_SECONDS - 86_400 }),
    ]);

    render(<Versions />);

    await waitFor(() => {
      expect(screen.getAllByText('PGM/PART1.H')).toHaveLength(2);
    });
    expect(screen.getByText('From machine')).toBeInTheDocument();
    expect(screen.getByText('From server')).toBeInTheDocument();
  });

  it('shows an empty state when a file has no history', async () => {
    mockApi([]);
    render(<Versions />);

    await waitFor(() => {
      expect(screen.getByText('No versions yet')).toBeInTheDocument();
    });
  });

  it('displays the retention policy so the operator knows what will be pruned', async () => {
    mockApi([version()]);
    render(<Versions />);

    await waitFor(() => {
      expect(screen.getByText('20 versions')).toBeInTheDocument();
    });
    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(screen.getByText(/Pinned versions .* are never pruned/)).toBeInTheDocument();
  });

  it('requires confirmation before restoring, and says the restore is reversible', async () => {
    mockApi([
      version({ id: 2, createdAt: NOW_SECONDS }),
      version({ id: 1, createdAt: NOW_SECONDS - 86_400 }),
    ]);
    render(<Versions />);

    await waitFor(() => expect(screen.getAllByText('PGM/PART1.H').length).toBeGreaterThan(0));

    // The second (older) entry — the newest is the current content and is not restorable.
    await userEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]!);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/can itself be undone/)).toBeInTheDocument();
    // Nothing has been sent yet: opening the dialog must not restore anything.
    expect(apiMock).not.toHaveBeenCalledWith('versions.restore', expect.anything());
  });

  it('sends the restore only after the confirming click', async () => {
    mockApi([
      version({ id: 2, createdAt: NOW_SECONDS }),
      version({ id: 1, createdAt: NOW_SECONDS - 86_400 }),
    ]);
    apiMock.mockImplementation((endpoint: string) => {
      if (endpoint === 'versions.list') {
        return Promise.resolve({
          items: [
            version({ id: 2, createdAt: NOW_SECONDS }),
            version({ id: 1, createdAt: NOW_SECONDS - 86_400 }),
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });
      }
      if (endpoint === 'config.get') {
        return Promise.resolve({ keepCount: 20, keepDays: 90, maxStoreGb: 10 });
      }
      if (endpoint === 'versions.restore') {
        return Promise.resolve({ restoredTo: 'PGM/PART1.H', preRestoreVersionId: 9 });
      }
      return Promise.resolve({});
    });

    render(<Versions />);
    await waitFor(() => expect(screen.getAllByText('PGM/PART1.H').length).toBeGreaterThan(0));

    await userEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]!);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('versions.restore', {
        params: { id: 1 },
        body: {},
      });
    });
    // The confirmation tells the operator how to undo what they just did.
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('saved as version 9');
    });
  });

  it('cancelling the dialog sends nothing', async () => {
    mockApi([
      version({ id: 2, createdAt: NOW_SECONDS }),
      version({ id: 1, createdAt: NOW_SECONDS - 86_400 }),
    ]);
    render(<Versions />);
    await waitFor(() => expect(screen.getAllByText('PGM/PART1.H').length).toBeGreaterThan(0));

    await userEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith('versions.restore', expect.anything());
  });

  it('marks the newest entry as current and refuses to restore over it', async () => {
    mockApi([
      version({ id: 2, createdAt: NOW_SECONDS }),
      version({ id: 1, createdAt: NOW_SECONDS - 86_400 }),
    ]);
    render(<Versions />);

    await waitFor(() => expect(screen.getByText('Current')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Restore' })[0]).toBeDisabled();
  });

  it('will not delete a pinned version', async () => {
    mockApi([version({ id: 1, pinned: true })]);
    render(<Versions />);

    await waitFor(() => expect(screen.getByText('Pinned')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('toggles a pin', async () => {
    mockApi([version({ id: 1, pinned: false })]);
    render(<Versions />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pin' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Pin' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('versions.pin', {
        params: { id: 1 },
        body: { pinned: true },
      });
    });
  });

  it('offers a preview only for small text files', async () => {
    mockApi([
      version({ id: 1, relPath: 'PGM/PART1.H', size: 1000 }),
      version({ id: 2, relPath: 'BLOB.BIN', size: 1000 }),
      version({ id: 3, relPath: 'HUGE.H', size: 10 * 1024 * 1024 }),
    ]);
    render(<Versions />);

    await waitFor(() => expect(screen.getAllByText(/PART1/).length).toBeGreaterThan(0));
    // Only the small .H file is previewable.
    expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(1);
  });
});
