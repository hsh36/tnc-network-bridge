import { useEffect, useRef, useState } from 'react';
import {
  API_BASE_PATH,
  BRIDGE_EVENT_TYPES,
  type BridgeEvent,
  type BridgeEventType,
} from '../../shared';

/**
 * Subscribes to `/events/stream` (T31/T33).
 *
 * Deliberately thin: the browser's native `EventSource` already does everything the
 * dashboard needs — automatic reconnect with backoff, and (once one `id:` field has
 * been seen) an automatic `Last-Event-ID` header on reconnect that the server uses to
 * replay whatever it missed. Re-implementing that in JavaScript would only risk
 * getting it wrong; this hook's job is just wiring events into React state.
 */

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface UseSSEOptions {
  readonly types?: readonly BridgeEventType[];
  readonly share?: number;
  /** How many recent events to keep in `events`. Older ones are dropped. */
  readonly maxEvents?: number;
  /** Set false to skip connecting (e.g. before the user is authenticated). */
  readonly enabled?: boolean;
}

export interface UseSSEResult {
  readonly state: ConnectionState;
  readonly events: readonly BridgeEvent[];
  readonly latest: BridgeEvent | undefined;
}

function buildUrl(options: UseSSEOptions): string {
  const params = new URLSearchParams();
  if (options.types !== undefined && options.types.length > 0) {
    params.set('types', options.types.join(','));
  }
  if (options.share !== undefined) {
    params.set('share', String(options.share));
  }
  const qs = params.toString();
  return `${API_BASE_PATH}/events/stream${qs.length > 0 ? `?${qs}` : ''}`;
}

export function useSSE(options: UseSSEOptions = {}): UseSSEResult {
  const { types, share, maxEvents = 200, enabled = true } = options;
  const [state, setState] = useState<ConnectionState>('connecting');
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const sourceRef = useRef<EventSource>();

  useEffect(() => {
    if (!enabled) {
      setState('closed');
      return;
    }
    setState('connecting');
    const url = buildUrl({
      ...(types !== undefined ? { types } : {}),
      ...(share !== undefined ? { share } : {}),
    });
    const source = new EventSource(url, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => setState('open');
    source.onerror = () => setState('closed');

    const handlers = BRIDGE_EVENT_TYPES.map((type) => {
      const handler = (evt: MessageEvent<string>): void => {
        try {
          const parsed = JSON.parse(evt.data) as BridgeEvent;
          setEvents((prev) => {
            const next = [...prev, parsed];
            return next.length > maxEvents ? next.slice(next.length - maxEvents) : next;
          });
        } catch {
          // A malformed event is dropped rather than crashing the dashboard.
        }
      };
      source.addEventListener(type, handler);
      return { type, handler };
    });

    return () => {
      for (const { type, handler } of handlers) {
        source.removeEventListener(type, handler);
      }
      source.close();
      sourceRef.current = undefined;
    };
    // `types` is compared by its joined string below rather than by array identity, so
    // a caller passing a fresh array literal each render does not reconnect needlessly.
  }, [enabled, share, maxEvents, types?.join(',')]);

  return { state, events, latest: events[events.length - 1] };
}
