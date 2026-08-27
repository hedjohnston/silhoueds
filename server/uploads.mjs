// The uploaded-image directory, and the only two things anyone does with it: serve a file back,
// or delete one that is no longer referenced.
//
// Both routers need this, and both used to carry their own copy of the path. One definition means
// the directory can't drift between the code that writes there and the code that reads.

import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_DIR = process.env.SILHOUEDS_UPLOADS ?? 'data/uploads';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Serve an uploaded image.
 *
 * Passing `root` makes Express reject any path that escapes the directory, and `basename` strips
 * a separator before it gets that far. Stored names are generated UUIDs, so neither guard is load
 * bearing today — but these filenames come out of the database and are handed to the filesystem,
 * and that pairing should be safe on its own terms rather than by luck.
 */
export function sendUpload(res, filename) {
  if (!filename) return res.status(404).end();
  res.sendFile(path.basename(filename), { root: path.resolve(UPLOAD_DIR) });
}

/** Remove an image that nothing references any more. Same containment reasoning as above. */
export function discard(filename) {
  if (filename) fs.rmSync(path.join(UPLOAD_DIR, path.basename(filename)), { force: true });
}
