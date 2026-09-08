import { Router } from 'express';
import { eventStreamQuerySchema, type BridgeEvent } from '../../../shared';
import { type AppContext } from '../context';
import { type SubscribeFilter } from '../event-bus';
import { requireSession } from '../middleware';

const HEARTBEAT_MS = 15_000;
/** Hard ceiling on simultaneous streams, so a slow-client leak cannot grow server memory unbounded. */
const MAX_CLIENTS = 200;

/**
 * `/events/stream` (T31) over the T26 {@link EventBus}.
 *
 * A client reconnecting with `Last-Event-ID` (sent automatically by the browser's
 * `EventSource` once an `id:` field has been seen) replays whatever the bus still
 * holds in its ring buffer instead of starting from a blank dashboard. A heartbeat
 * comment keeps intermediate proxies from timing out an otherwise idle connection.
 */
export function eventsRoutes(ctx: AppContext): Router {
  const router = Router();
  let activeClients = 0;

  router.get('/events/stream', requireSession(ctx), (req, res) => {
    const query = eventStreamQuerySchema.parse({
      ...req.query,
      lastEventId:
        req.header('last-event-id') ?? (req.query as Record<string, unknown>).lastEventId,
    });

    if (activeClients >= MAX_CLIENTS) {
      res.status(503).json({
        ok: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Too many open event streams' },
      });
      return;
    }
    activeClients += 1;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const filter: SubscribeFilter = {
      ...(query.types !== undefined ? { types: query.types } : {}),
      ...(query.share !== undefined ? { share: query.share } : {}),
    };

    const write = (id: number, event: BridgeEvent): void => {
      res.write(`id: ${id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    for (const entry of ctx.events.replaySince(query.lastEventId, filter)) {
      write(entry.id, entry.event);
    }

    const unsubscribe = ctx.events.subscribe((id, event) => {
      if (ctx.events.matches(event, filter)) {
        write(id, event);
      }
    });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      activeClients -= 1;
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}
