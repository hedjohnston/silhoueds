// Small helpers for reading things off a request that both route files need.

/**
 * The caller's IANA timezone, as reported by their browser.
 *
 * Both the game and the admin send it, so a day boundary is resolved where the person actually
 * is rather than wherever the server happens to run. Anything that isn't a plausible zone name is
 * ignored, and the caller falls back to the configured default.
 */
export function zoneOf(req) {
  const tz = req.query?.tz ?? req.body?.tz;
  return typeof tz === 'string' && tz.length <= 64 ? tz : undefined;
}
