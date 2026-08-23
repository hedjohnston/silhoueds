// Binary mask -> SVG path.
//
// Keeps the largest foreground blob (so a stray bystander doesn't come along), traces its
// boundary plus any genuine enclosed holes, simplifies the outlines, and fits the result into
// the game's 400x600 viewBox.

const VIEW = { width: 400, height: 600 };

/** Largest 4-connected foreground component, as a Uint8Array of the same size. */
export function largestComponent(binary, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  let best = null;
  let current = 0;

  for (let start = 0; start < binary.length; start++) {
    if (!binary[start] || labels[start] !== -1) continue;
    const queue = [start];
    labels[start] = current;
    const cells = [];
    while (queue.length) {
      const index = queue.pop();
      cells.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (x > 0) { const n = index - 1; if (binary[n] && labels[n] === -1) { labels[n] = current; queue.push(n); } }
      if (x < width - 1) { const n = index + 1; if (binary[n] && labels[n] === -1) { labels[n] = current; queue.push(n); } }
      if (y > 0) { const n = index - width; if (binary[n] && labels[n] === -1) { labels[n] = current; queue.push(n); } }
      if (y < height - 1) { const n = index + width; if (binary[n] && labels[n] === -1) { labels[n] = current; queue.push(n); } }
    }
    if (!best || cells.length > best.length) best = cells;
    current++;
  }

  const out = new Uint8Array(binary.length);
  for (const index of best ?? []) out[index] = 1;
  return { mask: out, area: best?.length ?? 0 };
}

/**
 * Background regions fully enclosed by the shape — real holes, as opposed to background that
 * reaches the image edge (the gap between the legs, say).
 */
export function enclosedHoles(mask, width, height, minArea) {
  const seen = new Uint8Array(mask.length);
  const holes = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    const cells = [];
    let touchesEdge = false;
    while (queue.length) {
      const index = queue.pop();
      cells.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      if (x > 0) { const n = index - 1; if (!mask[n] && !seen[n]) { seen[n] = 1; queue.push(n); } }
      if (x < width - 1) { const n = index + 1; if (!mask[n] && !seen[n]) { seen[n] = 1; queue.push(n); } }
      if (y > 0) { const n = index - width; if (!mask[n] && !seen[n]) { seen[n] = 1; queue.push(n); } }
      if (y < height - 1) { const n = index + width; if (!mask[n] && !seen[n]) { seen[n] = 1; queue.push(n); } }
    }
    if (!touchesEdge && cells.length >= minArea) {
      const hole = new Uint8Array(mask.length);
      for (const index of cells) hole[index] = 1;
      holes.push(hole);
    }
  }
  return holes;
}

/**
 * Moore-neighbour boundary trace of one region, returning its ring of boundary pixels.
 *
 * At each step the 8 neighbours are examined clockwise starting from the cell we arrived
 * from; the first filled one becomes the next boundary pixel, and the background cell
 * examined just before it becomes the new arrival direction. Jacob's stopping criterion
 * ends the walk: back at the start pixel, having arrived from the same direction as at the
 * beginning.
 */
export function traceBoundary(mask, width, height) {
  // Clockwise from east.
  const NEIGHBOURS = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const directionOf = new Map(NEIGHBOURS.map(([dx, dy], i) => [`${dx},${dy}`, i]));

  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];

  const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;

  let cx = start % width;
  let cy = (start / width) | 0;
  const startX = cx;
  const startY = cy;

  // The start pixel is the first filled one in raster order, so its western neighbour is
  // background — treat that as where we came from.
  const START_BACKTRACK = 4;
  let backtrack = START_BACKTRACK;

  const contour = [{ x: cx, y: cy }];
  const limit = width * height * 4;

  // Thin structures (a finger, a boot, a two-pixel diagonal) can re-enter the start pixel from
  // a new direction, so Jacob's criterion alone may never fire. Remembering each
  // position+direction state closes the walk at the true cycle instead.
  const seen = new Set([`${cx},${cy},${backtrack}`]);

  for (let step = 0; step < limit; step++) {
    let found = false;

    for (let k = 1; k <= 8; k++) {
      const index = (backtrack + k) % 8;
      const nx = cx + NEIGHBOURS[index][0];
      const ny = cy + NEIGHBOURS[index][1];
      if (!filled(nx, ny)) continue;

      // The cell examined just before this one is background; the new arrival direction is
      // where it sits relative to the pixel we're stepping onto.
      const previous = (index + 7) % 8;
      const px = cx + NEIGHBOURS[previous][0];
      const py = cy + NEIGHBOURS[previous][1];
      backtrack = directionOf.get(`${px - nx},${py - ny}`) ?? (index + 4) % 8;

      cx = nx;
      cy = ny;
      found = true;
      break;
    }

    if (!found) break; // isolated pixel
    if (cx === startX && cy === startY && backtrack === START_BACKTRACK) break;

    const state = `${cx},${cy},${backtrack}`;
    if (seen.has(state)) break;
    seen.add(state);

    contour.push({ x: cx, y: cy });
  }

  return contour;
}

/** Ramer-Douglas-Peucker, closed-polygon flavour. */
export function simplify(points, epsilon) {
  if (points.length < 3) return points;

  const distance = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };

  const run = (pts) => {
    if (pts.length < 3) return pts;
    let worst = 0;
    let index = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distance(pts[i], pts[0], pts[pts.length - 1]);
      if (d > worst) { worst = d; index = i; }
    }
    if (worst <= epsilon) return [pts[0], pts[pts.length - 1]];
    return [...run(pts.slice(0, index + 1)).slice(0, -1), ...run(pts.slice(index))];
  };

  // Split at the extreme point so the closing edge doesn't anchor the whole simplification.
  const split = Math.floor(points.length / 2);
  const first = run([...points.slice(0, split + 1)]);
  const second = run([...points.slice(split), points[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/** Round-cornered polygon: quadratic curves through edge midpoints. */
function toPath(points, round) {
  if (points.length < 3) return '';
  const p = points.map((q) => ({ x: q.x, y: q.y }));
  if (!round) {
    return `M${p.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join('L')}Z`;
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = '';
  const first = mid(p[p.length - 1], p[0]);
  d += `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let i = 0; i < p.length; i++) {
    const corner = p[i];
    const next = mid(p[i], p[(i + 1) % p.length]);
    d += `Q${corner.x.toFixed(1)} ${corner.y.toFixed(1)} ${next.x.toFixed(1)} ${next.y.toFixed(1)}`;
  }
  return `${d}Z`;
}

/**
 * Turn a binary mask into finished SVG markup.
 * `binary` is 1 per foreground pixel, row-major, `width` x `height`.
 */
export function maskToSvg(binary, width, height, { epsilon = 1.2, round = true, minHoleRatio = 0.004 } = {}) {
  const { mask, area } = largestComponent(binary, width, height);
  if (area < 40) return null;

  const rings = [traceBoundary(mask, width, height)];
  for (const hole of enclosedHoles(mask, width, height, Math.max(20, area * minHoleRatio))) {
    rings.push(traceBoundary(hole, width, height));
  }

  const simplified = rings.map((ring) => simplify(ring, epsilon)).filter((ring) => ring.length >= 3);
  if (simplified.length === 0) return null;

  // Fit the outer ring to the viewBox, keeping aspect ratio, with a little breathing room.
  const outer = simplified[0];
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 12;
  const scale = Math.min(
    (VIEW.width - pad * 2) / Math.max(1, maxX - minX),
    (VIEW.height - pad * 2) / Math.max(1, maxY - minY),
  );
  const offsetX = (VIEW.width - (maxX - minX) * scale) / 2;
  const offsetY = (VIEW.height - (maxY - minY) * scale) / 2;
  const place = (ring) =>
    ring.map((p) => ({ x: (p.x - minX) * scale + offsetX, y: (p.y - minY) * scale + offsetY }));

  const d = simplified.map((ring) => toPath(place(ring), round)).join('');

  // The label stays generic: this markup is served to players.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW.width} ${VIEW.height}" ` +
    `role="img" aria-label="Today's silhouette">\n  ` +
    `<path fill="currentColor" fill-rule="evenodd" d="${d}"/>\n</svg>\n`
  );
}
