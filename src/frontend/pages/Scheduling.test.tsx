import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Schedule } from '../../shared';
import type * as ApiClientModule from '../lib/api-client';
import { formatNextRun, Scheduling } from './Scheduling';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../lib/api-client');
  return { ...actual, api: apiMock };
});

const NOW_SECONDS = 1_700_000_000;

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    name: 'nightly prune',
    kind: 'prune',
    cron: '0 3 * * *',
    target: null,
    enabled: true,
    lastRunAt: NOW_SECONDS - 3600,
    nextRunAt: NOW_SECONDS + 7200,
    lastResult: 'ok',
    lastError: null,
    ...overrides,
  };
}

function mockApi(schedules: Schedule[], overrides: Record<string, unknown> = {}): void {
  apiMock.mockImplementation((endpoint: string) => {
    if (endpoint === 'schedules.list') {
      return Promise.resolve({ items: schedules, total: schedules.length, limit: 100, offset: 0 });
    }
    if (endpoint in overrides) {
      return Promise.resolve(overrides[endpoint]);
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('formatNextRun', () => {
  const now = NOW_SECONDS * 1000;

  it('reports never for a schedule with no next occurrence', () => {
    expect(formatNextRun(null, now)).toBe('never');
  });

  it('reports due now for a time already passed', () => {
    expect(formatNextRun(NOW_SECONDS - 10, now)).toBe('due now');
  });

  it('scales through minutes, hours and days', () => {
    expect(formatNextRun(NOW_SECONDS + 600, now)).toBe('in 10 min');
    expect(formatNextRun(NOW_SECONDS + 7200, now)).toBe('in 2 h');
    expect(formatNextRun(NOW_SECONDS + 3 * 86_400, now)).toBe('in 3 d');
  });
});

describe('Scheduling page', () => {
  it('lists schedules with their kind and cron', async () => {
    mockApi([schedule()]);
    render(<Scheduling />);

    await waitFor(() => expect(screen.getByText('nightly prune')).toBeInTheDocument());

    // Scoped to the row: "Prune old versions" is also one of the <select> options, so an
    // unscoped query would match twice and prove nothing about what the list renders.
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Prune old versions')).toBeInTheDocument();
    expect(within(row).getByText(/0 3 \* \* \*/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is scheduled', async () => {
    mockApi([]);
    render(<Scheduling />);

    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());
  });

  it('surfaces a failing job rather than hiding it', async () => {
    mockApi([schedule({ lastResult: 'error', lastError: 'server unreachable' })]);
    render(<Scheduling />);

    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
    expect(screen.getByText('server unreachable')).toBeInTheDocument();
  });

  it('previews the real firing times before the expression is saved', async () => {
    mockApi([], {
      'schedules.preview': {
        cron: '0 3 * * *',
        nextRuns: [NOW_SECONDS + 3600, NOW_SECONDS + 90_000],
      },
    });
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() => {
      expect(screen.getByText('This will next run:')).toBeInTheDocument();
    });
    expect(apiMock).toHaveBeenCalledWith('schedules.preview', { body: { cron: '0 3 * * *' } });
  });

  it('reports an expression the server rejects', async () => {
    apiMock.mockImplementation((endpoint: string) => {
      if (endpoint === 'schedules.list') {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      if (endpoint === 'schedules.preview') {
        return Promise.reject(
          new (class extends Error {
            constructor() {
              super('Not a usable cron expression');
            }
          })(),
        );
      }
      return Promise.resolve({});
    });
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('applies a preset to the cron field', async () => {
    mockApi([]);
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Every hour' }));

    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 * * * *');
  });

  it('will not submit without a name', async () => {
    mockApi([]);
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('requires a path glob for a lock window, since one without it locks nothing', async () => {
    mockApi([]);
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Name'), 'night shift lock');
    await userEvent.selectOptions(screen.getByLabelText('What it does'), 'lock');

    // The glob field appears and gates submission.
    expect(screen.getByLabelText('Which paths')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Which paths'), '**/*.H');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('creates a schedule with the entered values', async () => {
    mockApi([], { 'schedules.create': schedule() });
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Name'), 'nightly prune');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('schedules.create', {
        body: {
          name: 'nightly prune',
          kind: 'prune',
          cron: '0 3 * * *',
          target: null,
          enabled: true,
        },
      });
    });
  });

  it('runs a schedule on demand and reports the result', async () => {
    mockApi([schedule()], { 'schedules.run': { accepted: true, result: 'ok' } });
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('nightly prune')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('ran with result: ok');
    });
  });

  it('toggles a schedule between enabled and disabled', async () => {
    mockApi([schedule({ enabled: true })]);
    render(<Scheduling />);
    await waitFor(() => expect(screen.getByText('nightly prune')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('schedules.update', {
        params: { id: 1 },
        body: { enabled: false },
      });
    });
  });

  it('marks a disabled schedule and hides its next run', async () => {
    mockApi([schedule({ enabled: false })]);
    render(<Scheduling />);

    await waitFor(() => expect(screen.getByText('Disabled')).toBeInTheDocument());
    expect(screen.queryByText(/next in/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });
});
