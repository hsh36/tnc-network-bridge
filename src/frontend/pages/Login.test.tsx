import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api-client';
import { Login } from './Login';

const loginMock = vi.fn();

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    login: loginMock,
    session: undefined,
    loading: false,
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('Login', () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it('submits the entered credentials', async () => {
    loginMock.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await userEvent.clear(screen.getByLabelText('Username'));
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'Sup3rGeheim!Passwort-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(loginMock).toHaveBeenCalledWith('admin', 'Sup3rGeheim!Passwort-2026');
  });

  it('shows the server error message when login fails', async () => {
    loginMock.mockRejectedValue(
      new ApiError('INVALID_CREDENTIALS', 'Invalid username or password', 401),
    );
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
  });
});
