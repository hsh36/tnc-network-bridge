import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactRouterModule from 'react-router-dom';
import type * as ApiClientModule from '../lib/api-client';
import { ApiError } from '../lib/api-client';
import { Setup } from './Setup';

const apiMock = vi.hoisted(() => vi.fn());
const loginMock = vi.hoisted(() => vi.fn());
const refreshSetupMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

// Only `api` is replaced; `ApiError` and the rest stay real, so the page's
// `err instanceof ApiError` branches behave as they do in the browser.
vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../lib/api-client');
  return { ...actual, api: apiMock };
});

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    login: loginMock,
    session: undefined,
    loading: false,
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useSetupStatus', () => ({
  useSetupStatus: () => ({ status: undefined, loading: false, refresh: refreshSetupMock }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof ReactRouterModule>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

function renderSetup(): void {
  render(
    <MemoryRouter>
      <Setup />
    </MemoryRouter>,
  );
}

async function fillPasswordStep(password: string, confirmation = password): Promise<void> {
  await userEvent.type(screen.getByLabelText('New password'), password);
  await userEvent.type(screen.getByLabelText('Confirm password'), confirmation);
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
}

describe('Setup', () => {
  beforeEach(() => {
    apiMock.mockReset();
    loginMock.mockReset();
    refreshSetupMock.mockReset();
    navigateMock.mockReset();
    apiMock.mockResolvedValue({ acknowledged: true });
    loginMock.mockResolvedValue(undefined);
    refreshSetupMock.mockResolvedValue(undefined);
  });

  it('rejects a password below the server minimum without a round trip', async () => {
    renderSetup();

    await fillPasswordStep('kurz');

    expect(await screen.findByText('Password must be at least 12 characters')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('rejects a mistyped confirmation without a round trip', async () => {
    renderSetup();

    await fillPasswordStep(PASSWORD, `${PASSWORD}-typo`);

    expect(await screen.findByText('The two passwords do not match')).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('sets the password and signs in with it', async () => {
    renderSetup();

    await fillPasswordStep(PASSWORD);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('setup.password', { body: { password: PASSWORD } });
    });
    // Setting the password revokes every session, so signing in here is what gives this
    // browser the session that `setup.complete` requires.
    expect(loginMock).toHaveBeenCalledWith('admin', PASSWORD);
    expect(await screen.findByRole('button', { name: 'Finish setup' })).toBeInTheDocument();
  });

  it('surfaces a server rejection instead of advancing', async () => {
    apiMock.mockRejectedValue(new ApiError('VALIDATION_FAILED', 'Password is too common', 400));
    renderSetup();

    await fillPasswordStep('passwordpassword');

    expect(await screen.findByText('Password is too common')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish setup' })).not.toBeInTheDocument();
  });

  it('closes the public setup endpoint when finishing', async () => {
    renderSetup();
    await fillPasswordStep(PASSWORD);
    await screen.findByRole('button', { name: 'Finish setup' });

    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    // This call is the only thing that ever flips setup.completed, and until it lands
    // `POST /setup/password` stays reachable without a session.
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('setup.complete', { body: {} });
    });
    expect(refreshSetupMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('keeps the operator on the wizard if finishing fails', async () => {
    renderSetup();
    await fillPasswordStep(PASSWORD);
    await screen.findByRole('button', { name: 'Finish setup' });

    apiMock.mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'Could not write the flag', 500));
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByText('Could not write the flag')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
