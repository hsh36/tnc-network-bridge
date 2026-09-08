import { type Db } from './db';

/**
 * Resolving a share id to its local cache root.
 *
 * Every subsystem that turns an API-supplied path into a filesystem path needs this, and
 * all of them must agree — a restore, a version capture and a sync write that disagreed
 * about where share 3 lives would corrupt each other. So it is one function reading one
 * column, rather than each caller assembling `/srv/tnc/<name>` from its own idea of the
 * naming convention.
 *
 * It reads the database on every call rather than caching. Shares are created and deleted
 * while the process runs, and a stale cached root is precisely the kind of bug that ends
 * with files written into a deleted share's directory.
 */

export class UnknownShareError extends Error {
  constructor(readonly shareId: number) {
    super(`No share with id ${shareId}`);
    this.name = 'UnknownShareError';
  }
}

/** Returns a resolver closed over `db`, suitable for `AppContext.shareCacheRoot`. */
export function createShareCacheRootResolver(db: Db): (shareId: number) => string {
  return (shareId: number): string => {
    const path = db.pluck<string>('SELECT cache_path FROM shares WHERE id = @id', { id: shareId });
    if (path === undefined) {
      throw new UnknownShareError(shareId);
    }
    return path;
  };
}
