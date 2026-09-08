import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { Machines } from './Machines';
import * as useApiModule from '../hooks/useApi';

vi.mock('../hooks/useApi');

const mockMachines = [
  {
    id: 1,
    name: 'TNC-001',
    mac: 'aa:bb:cc:dd:ee:01',
    ip: '192.168.1.100',
    model: 'TNC640' as const,
    dhcpStatic: false,
    firstSeenAt: Math.floor(Date.now() / 1000) - 86400,
    lastSeenAt: Math.floor(Date.now() / 1000) - 60,
    notes: null,
  },
  {
    id: 2,
    name: null,
    mac: 'aa:bb:cc:dd:ee:02',
    ip: '192.168.1.101',
    model: 'iTNC530' as const,
    dhcpStatic: true,
    firstSeenAt: Math.floor(Date.now() / 1000) - 86400,
    lastSeenAt: Math.floor(Date.now() / 1000) - 3600,
    notes: null,
  },
];

describe('Machines page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page header and description', () => {
    vi.mocked(useApiModule.useApiQuery).mockReturnValue({
      data: { items: [], total: 0 },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });

    render(
      <BrowserRouter>
        <Machines />
      </BrowserRouter>,
    );

    expect(screen.getByText('Machines')).toBeInTheDocument();
    expect(
      screen.getByText('Discovered TNC machines on the network.'),
    ).toBeInTheDocument();
  });

  it('displays the list of discovered machines', () => {
    vi.mocked(useApiModule.useApiQuery).mockReturnValue({
      data: { items: mockMachines, total: 2 },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });

    render(
      <BrowserRouter>
        <Machines />
      </BrowserRouter>,
    );

    expect(screen.getByText('TNC-001')).toBeInTheDocument();
    expect(screen.getByText('aa:bb:cc:dd:ee:01')).toBeInTheDocument();
    expect(screen.getByText('TNC640')).toBeInTheDocument();
    expect(screen.getByText('iTNC530')).toBeInTheDocument();
  });

  it('shows online status for recently active machines', () => {
    vi.mocked(useApiModule.useApiQuery).mockReturnValue({
      data: { items: mockMachines, total: 2 },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });

    render(
      <BrowserRouter>
        <Machines />
      </BrowserRouter>,
    );

    const statusBadges = screen.getAllByText(/Online|Offline/);
    expect(statusBadges.length).toBeGreaterThan(0);
  });

  it('displays correct machine count', () => {
    vi.mocked(useApiModule.useApiQuery).mockReturnValue({
      data: { items: mockMachines, total: 2 },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });

    render(
      <BrowserRouter>
        <Machines />
      </BrowserRouter>,
    );

    expect(screen.getByText(/2 machines found/)).toBeInTheDocument();
  });

  it('shows empty state when no machines are discovered', () => {
    vi.mocked(useApiModule.useApiQuery).mockReturnValue({
      data: { items: [], total: 0 },
      error: undefined,
      loading: false,
      refresh: vi.fn(),
    });

    render(
      <BrowserRouter>
        <Machines />
      </BrowserRouter>,
    );

    expect(screen.getByText('No machines discovered')).toBeInTheDocument();
    expect(
      screen.getByText('Machines appearing on the TNC network will be listed here.'),
    ).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    vi.mocked(useApiModule.useApiQuery).mockReturnValue({
      data: undefined,
      error: undefined,
      loading: true,
      refresh: vi.fn(),
    });

    render(
      <BrowserRouter>
        <Machines />
      </BrowserRouter>,
    );

    // The FullPageSpinner should be rendered
    // This is a basic check - actual implementation may vary
    const mainContent = screen.queryByText('Machines');
    expect(mainContent).not.toBeInTheDocument();
  });
});
