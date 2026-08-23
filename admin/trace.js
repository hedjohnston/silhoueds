// Click-to-trace silhouette editor. The admin drops points around the player in the reference
// photo; the polygon becomes the SVG path stored on the player.

const VIEW = { width: 400, height: 600 };
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Catmull-Rom through the points, emitted as cubic beziers, closed. */
function smoothPath(points) {
  const at = (i) => points[(i + points.length) % points.length];
  let d = `M ${at(0).x.toFixed(1)} ${at(0).y.toFixed(1)}`;
  for (let i = 0; i < points.length; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return `${d} Z`;
}

function straightPath(points) {
  return `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`;
}

export function pathFrom(points, smooth) {
  if (points.length < 3) return '';
  return smooth ? smoothPath(points) : straightPath(points);
}

export function svgFrom(points, smooth) {
  const d = pathFrom(points, smooth);
  if (!d) return null;
  // The label is deliberately generic: this markup is served to players, so naming the
  // footballer here would hand them the answer through the DOM.
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${VIEW.width} ${VIEW.height}" role="img" ` +
    `aria-label="Today's silhouette">\n  ` +
    `<path fill="currentColor" d="${d}"/>\n</svg>\n`
  );
}

/**
 * Wire up the tracing surface.
 * Returns { load, points, toSvg, undo, clear, setSmooth } for the dialog to drive.
 */
export function createTracer({ stage, svg, preview, onChange }) {
  let points = [];
  let smooth = true;
  let dragging = null;

  const toLocal = (event) => {
    const rect = svg.getBoundingClientRect();
    // The SVG letterboxes inside the stage (preserveAspectRatio), so map through the
    // displayed box rather than assuming it fills the element.
    const scale = Math.min(rect.width / VIEW.width, rect.height / VIEW.height);
    const offsetX = (rect.width - VIEW.width * scale) / 2;
    const offsetY = (rect.height - VIEW.height * scale) / 2;
    return {
      x: Math.round((event.clientX - rect.left - offsetX) / scale),
      y: Math.round((event.clientY - rect.top - offsetY) / scale),
    };
  };

  function draw() {
    svg.textContent = '';

    if (points.length >= 3) {
      const shape = document.createElementNS(SVG_NS, 'path');
      shape.setAttribute('d', pathFrom(points, smooth));
      shape.setAttribute('class', 'trace-shape');
      svg.append(shape);
    } else if (points.length === 2) {
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
      line.setAttribute('class', 'trace-line');
      svg.append(line);
    }

    points.forEach((point, index) => {
      const handle = document.createElementNS(SVG_NS, 'circle');
      handle.setAttribute('cx', point.x);
      handle.setAttribute('cy', point.y);
      handle.setAttribute('r', 6);
      handle.setAttribute('class', 'trace-handle');
      handle.dataset.index = String(index);
      svg.append(handle);
    });

    preview.innerHTML = points.length >= 3 ? svgFrom(points, smooth) : '';
    onChange?.(points.length);
  }

  svg.addEventListener('pointerdown', (event) => {
    const index = event.target.dataset?.index;
    if (index !== undefined) {
      dragging = { index: Number(index), moved: false };
      svg.setPointerCapture(event.pointerId);
      return;
    }
    points.push(toLocal(event));
    draw();
  });

  svg.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    dragging.moved = true;
    points[dragging.index] = toLocal(event);
    draw();
  });

  svg.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    // A click without movement removes the point; a drag repositions it.
    if (!dragging.moved) {
      points.splice(dragging.index, 1);
      draw();
    }
    svg.releasePointerCapture(event.pointerId);
    dragging = null;
  });

  return {
    load(existingPoints = []) {
      points = [...existingPoints];
      draw();
    },
    setSmooth(value) {
      smooth = value;
      draw();
    },
    undo() {
      points.pop();
      draw();
    },
    clear() {
      points = [];
      draw();
    },
    get points() {
      return points;
    },
    toSvg() {
      return svgFrom(points, smooth);
    },
  };
}
