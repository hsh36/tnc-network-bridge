import { type BridgeEvent, type BridgeEventType } from '../../shared';

/**
 * The in-process event bus behind `/events/stream` and `/logs/stream` (T30).
 *
 * The dashboard is meant to be driven entirely by SSE rather than polling (see the
 * `events.ts` schema comment), which only works if a client that briefly drops its
 * connection can resume without a gap. `Last-Event-ID` is the standard SSE mechanism
 * for that, so every published event gets a monotonic id and a short backlog is kept
 * so a reconnect can replay what it missed rather than starting from a blank slate.
 *
 * Every subsystem publishes into the same bus — {@link LockManager} events and
 * {@link ConfigManager} changes are wired in by the composition root, and the sync
 * engine (Opus's track) publishes into it the same way once it exists. Nothing here
 * depends on which subsystems are wired up yet.
 */

export type EventHandler = (id: number, event: BridgeEvent) => void;
export type Unsubscribe = () => void;

export interface SubscribeFilter {
  readonly types?: readonly BridgeEventType[];
  readonly share?: number;
}

interface BufferedEvent {
  readonly id: number;
  readonly event: BridgeEvent;
}

/** Extracts `shareId` from whichever event variants carry one, for filtering. */
function shareIdOf(event: BridgeEvent): number | undefined {
  switch (event.type) {
    case 'share.state':
      return event.share.id;
    case 'sync.progress':
      return event.shareId;
    case 'sync.event':
      return event.event.shareId ?? undefined;
    case 'lock':
      return event.lock.shareId;
    case 'conflict':
      return event.conflict.shareId;
    case 'failover':
      return event.shareId;
    case 'log':
      return event.entry.shareId ?? undefined;
    case 'heartbeat':
    case 'status':
    case 'update':
      return undefined;
  }
}

export interface EventBusOptions {
  /** How many recent events are kept for `Last-Event-ID` replay. */
  readonly bufferSize?: number;
}

export class EventBus {
  private readonly buffer: BufferedEvent[] = [];
  private readonly bufferSize: number;
  private readonly handlers = new Set<EventHandler>();
  private nextId = 1;

  constructor(options: EventBusOptions = {}) {
    this.bufferSize = options.bufferSize ?? 500;
  }

  publish(event: BridgeEvent): number {
    const id = this.nextId;
    this.nextId += 1;
    this.buffer.push({ id, event });
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
    for (const handler of [...this.handlers]) {
      try {
        handler(id, event);
      } catch {
        // A misbehaving subscriber must never break publishing for everyone else.
      }
    }
    return id;
  }

  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Buffered events after `lastEventId`, matching `filter`. Empty if nothing qualifies. */
  replaySince(lastEventId: string | undefined, filter: SubscribeFilter = {}): BufferedEvent[] {
    const afterId = lastEventId === undefined ? undefined : Number.parseInt(lastEventId, 10);
    return this.buffer.filter((entry) => {
      if (afterId !== undefined && Number.isFinite(afterId) && entry.id <= afterId) {
        return false;
      }
      return matchesFilter(entry.event, filter);
    });
  }

  matches(event: BridgeEvent, filter: SubscribeFilter): boolean {
    return matchesFilter(event, filter);
  }
}

function matchesFilter(event: BridgeEvent, filter: SubscribeFilter): boolean {
  if (filter.types !== undefined && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.share !== undefined && shareIdOf(event) !== filter.share) {
    return false;
  }
  return true;
}
