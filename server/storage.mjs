// Is the data actually on a persistent disk?
//
// db.mjs creates its directory if it is missing, so a container with no volume attached runs
// perfectly and quietly loses everything on the next restart. That failure is invisible until
// the day it costs you your players, so check for it and say so loudly.

import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './db.mjs';

/**
 * Anything on a mounted volume sits on a different filesystem from the container's root, so the
 * two report different device ids. Comparing against `/` — rather than against the directory's
 * own parent — means a volume mounted anywhere above the data directory still counts, so
 * `/data/db/silhoueds.db` on a volume at `/data` is correctly seen as persistent.
 */
export function storageStatus() {
  const directory = path.resolve(path.dirname(DB_PATH));

  try {
    const mounted = fs.statSync(directory).dev !== fs.statSync('/').dev;
    return { directory, mounted, checked: true };
  } catch {
    // Can't tell; don't claim a problem we haven't established.
    return { directory, mounted: true, checked: false };
  }
}

/** Warn at startup when a production deploy is writing somewhere it will lose. */
export function warnIfEphemeral() {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.SILHOUEDS_ACCEPT_EPHEMERAL === 'true') return;

  const { directory, mounted, checked } = storageStatus();
  if (!checked || mounted) return;

  console.warn(
    [
      '',
      '  ****************************************************************',
      '  *  WARNING: data is NOT on a persistent disk.                  *',
      '  ****************************************************************',
      `  Writing to: ${directory}`,
      '',
      '  Nothing is mounted there, so every player, image and result is',
      '  stored inside this container and will be lost on the next',
      '  restart or deploy.',
      '',
      '  On Fly.io: check that fly.toml still has its [[mounts]] block',
      '  and that the volume exists (fly volumes list). `fly launch` can',
      '  rewrite fly.toml and drop it.',
      '',
      '  Set SILHOUEDS_ACCEPT_EPHEMERAL=true to silence this if the data',
      '  really is disposable.',
      '',
    ].join('\n'),
  );
}
