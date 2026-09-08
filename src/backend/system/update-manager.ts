import { type BridgeEvent } from '../../shared';
import { type UpdateStatus, type UpdatePhase } from '../../shared/schemas/operations';

/**
 * Minimal update manager for T44.
 *
 * This is a placeholder that implements the endpoints and SSE event publishing.
 * The full T43 implementation would add:
 * - GitHub Releases polling
 * - SHA256 verification
 * - Extract and install logic
 * - Health gate polling
 * - Automatic rollback on failure
 */

export interface UpdateManagerOptions {
  readonly currentVersion: string;
  readonly publishEvent: (event: BridgeEvent) => void;
}

export class UpdateManager {
  private currentVersion: string;
  private phase: UpdatePhase = 'idle';
  private progressPct: number | null = null;
  private available: {
    version: string;
    channel: 'stable' | 'beta';
    publishedAt: number;
    notes: string;
    assetUrl: string;
    assetSize: number;
    sha256: string;
  } | null = null;
  private lastCheckAt: number | null = null;
  private lastError: string | null = null;
  private rollbackVersion: string | null = null;
  private publishEvent: (event: BridgeEvent) => void;
  private updateHistory: Array<{
    id: string;
    ts: number;
    fromVersion: string | null;
    toVersion: string | null;
    channel: 'stable' | 'beta' | 'dev' | null;
    result: 'ok' | 'failed' | 'rolled_back';
    log: string | null;
  }> = [];

  constructor(options: UpdateManagerOptions) {
    this.currentVersion = options.currentVersion;
    this.publishEvent = options.publishEvent;
  }

  getStatus(): UpdateStatus {
    return {
      currentVersion: this.currentVersion,
      available: this.available,
      phase: this.phase,
      progressPct: this.progressPct,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      rollbackVersion: this.rollbackVersion,
    };
  }

  async check(): Promise<UpdateStatus> {
    this.phase = 'checking';
    this.publishStatus();

    try {
      // Placeholder: in T43, this would call GitHub Releases API
      this.lastCheckAt = Math.floor(Date.now() / 1000);
      this.lastError = null;
      this.phase = 'idle';
      this.publishStatus();
      return this.getStatus();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.phase = 'idle';
      this.publishStatus();
      throw error;
    }
  }

  async apply(_version?: string): Promise<void> {
    if (this.phase !== 'idle') {
      throw new Error(`Cannot apply update while ${this.phase}`);
    }

    this.phase = 'downloading';
    this.progressPct = 0;
    this.publishStatus();

    try {
      // Placeholder phases for T43 implementation
      const phases: UpdatePhase[] = [
        'downloading',
        'verifying',
        'extracting',
        'installing',
        'migrating',
        'switching',
        'restarting',
        'health_gate',
      ];

      for (const phase of phases) {
        this.phase = phase;
        for (let i = 0; i <= 100; i += 20) {
          this.progressPct = i;
          this.publishStatus();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      this.phase = 'done';
      this.progressPct = 100;
      this.publishStatus();

      // Record in history
      this.addHistoryEntry(true, 'ok', null);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.phase = 'failed';
      this.publishStatus();
      this.addHistoryEntry(false, 'failed', this.lastError);
      throw error;
    }
  }

  async rollback(): Promise<void> {
    if (!this.rollbackVersion) {
      throw new Error('No previous version available for rollback');
    }

    this.phase = 'rolling_back';
    this.progressPct = 0;
    this.publishStatus();

    try {
      // Simulate rollback
      for (let i = 0; i <= 100; i += 20) {
        this.progressPct = i;
        this.publishStatus();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      this.phase = 'done';
      this.progressPct = 100;
      const previousVersion = this.currentVersion;
      this.currentVersion = this.rollbackVersion;
      this.rollbackVersion = previousVersion;
      this.publishStatus();

      this.addHistoryEntry(false, 'rolled_back', null);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.phase = 'failed';
      this.publishStatus();
      throw error;
    }
  }

  getHistory(): Array<{
    id: string;
    ts: number;
    fromVersion: string | null;
    toVersion: string | null;
    channel: 'stable' | 'beta' | 'dev' | null;
    result: 'ok' | 'failed' | 'rolled_back';
    log: string | null;
  }> {
    return this.updateHistory;
  }

  private publishStatus(): void {
    this.publishEvent({
      ts: Date.now(),
      type: 'update',
      status: this.getStatus(),
    });
  }

  private addHistoryEntry(
    success: boolean,
    result: 'ok' | 'failed' | 'rolled_back',
    log: string | null,
  ): void {
    this.updateHistory.push({
      id: `update-${Date.now()}`,
      ts: Math.floor(Date.now() / 1000),
      fromVersion: null,
      toVersion: success ? this.currentVersion : null,
      channel: null,
      result,
      log,
    });
  }
}
