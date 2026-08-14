// GENERATED FILE -- do not edit directly.
// Source: shared/draw-engine.js (run shared/sync-vendor-copies.ps1 after editing it).

(function () {
// Shared canvas/layer/brush primitives used by both PaintSoft and TrainingDraw.
//
// This is the single source of truth. DO NOT import this file directly from either
// app — each app consumes a generated vendor copy instead (see README.md in this
// folder for why). After editing this file, run sync-vendor-copies.ps1 to update:
//   - PaintSoft/vendor/draw-engine.js      (classic script, window.DrawEngine)
//   - TrainingDraw/src/vendor/draw-engine.js (verbatim ES module copy)
//
// Every function here is pure: no DOM globals, no app-level state reads. Undo/redo
// bookkeeping and UI wiring stay local to each app.

function createLayerCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Snapshots the canvas's current bitmap, resizes it, then redraws the snapshot
// scaled into the new size. Resizing a canvas resets its 2D context state
// (lineCap, lineJoin, etc.) — the caller is responsible for re-applying those.
function resizeCanvasPreservingContent(canvas, newWidth, newHeight) {
  const oldWidth = canvas.width;
  const oldHeight = canvas.height;

  let snapshot = null;
  if (oldWidth > 0 && oldHeight > 0) {
    snapshot = document.createElement('canvas');
    snapshot.width = oldWidth;
    snapshot.height = oldHeight;
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
  }

  canvas.width = newWidth;
  canvas.height = newHeight;

  if (snapshot && newWidth > 0 && newHeight > 0) {
    canvas.getContext('2d').drawImage(snapshot, 0, 0, oldWidth, oldHeight, 0, 0, newWidth, newHeight);
  }
}

// Draws each visible layer (in array order) onto ctx. layers: [{ canvas, visible?, opacity? }].
// Pass { clear: false } when the caller has already painted a background it wants preserved.
function compositeLayers(ctx, width, height, layers, { clear = true } = {}) {
  if (clear) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
  }

  for (const layer of layers) {
    if (layer.visible === false) continue;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.drawImage(layer.canvas, 0, 0);
  }

  ctx.globalAlpha = 1;
}

// Maps a pointer/mouse/touch event to canvas pixel coordinates using the ratio
// between the canvas's CSS display size and its backing-store size. Works
// regardless of how the backing store size was chosen (device-pixel-ratio driven
// or tied 1:1 to a document resolution).
function pointerToCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const clientX = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
  const clientY = event.clientY ?? event.touches?.[0]?.clientY ?? 0;

  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height,
  };
}

// Converts a CSS color string (hex or rgb/rgba(...), the only forms either app ever sets as
// fillStyle) to the same color at the given alpha (0..1), for the soft-edge gradient in
// stampDot below. Anything else (e.g. fillStyle already being a CanvasGradient) is returned
// unchanged, which just skips the soft-edge effect rather than throwing.
function toAlphaColor(color, alpha) {
  if (typeof color !== 'string') return color;
  if (color[0] === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => s.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

// Fills a circle with NO anti-aliasing at all — a genuinely binary/pixelated edge, for
// blur=0. ctx.fill() on an arc path is always browser-anti-aliased with no way to opt out,
// so this instead draws one integer-aligned fillRect per scanline: axis-aligned rects at
// integer coordinates rasterize pixel-exact with no edge blending. Using fillRect (not
// putImageData) means this still respects the caller's current fillStyle/globalAlpha/
// globalCompositeOperation, unlike a raw pixel-buffer write.
//
// The float `radius` is used directly in each row's width calculation instead of rounding it
// once up front — rounding first meant every row shared the same integer radius, so the
// whole circle's outline jumped by a full pixel in lockstep whenever that rounded value
// ticked over, which reads as a visible "pop" when radius grows continuously (e.g. driven by
// pressure). Different rows cross their own half-pixel width thresholds at different radius
// values, so keeping the float radius lets the circle grow one row-width at a time instead —
// still a fully binary edge (only the final per-row width is ever rounded), just a much finer
// (and much smoother-looking) growth step than a whole extra ring at once.
function stampBinaryDot(ctx, cx, cy, radius) {
  if (radius <= 0.5) {
    ctx.fillRect(Math.round(cx), Math.round(cy), 1, 1);
    return;
  }
  const centerX = Math.round(cx);
  const centerY = Math.round(cy);
  const rCeil = Math.ceil(radius);
  const r2 = radius * radius;
  for (let dy = -rCeil; dy <= rCeil; dy++) {
    if (dy * dy > r2) continue;
    const dx = Math.floor(Math.sqrt(r2 - dy * dy));
    ctx.fillRect(centerX - dx, centerY + dy, dx * 2 + 1, 1);
  }
}

// blur: 0 (fully hard — a genuinely binary edge with no anti-aliasing at all, the default)
// to 100 (a soft airbrush-style spray: a small solid core fading through a wide, hazy halo
// that extends well past the nominal brush radius). This is what "ペン先のアンチエイリアス" /
// brush hardness controls in most illustration software, framed the way a blur amount usually
// reads: 0 = none, higher = more.
//
// AIRBRUSH_SPREAD controls how far the visible halo reaches beyond `radius` at blur=100 (a
// factor of 1 + AIRBRUSH_SPREAD, i.e. 2.6x the nominal radius) — real airbrush spray fans out
// well past the nozzle's nominal width, so a blur that stayed confined to `radius` never read
// as "airbrush" no matter how soft its inner falloff was.
const AIRBRUSH_SPREAD = 1.6;

function stampDot(ctx, x, y, radius, blur = 0) {
  if (radius <= 0) return;

  const b = Math.max(0, Math.min(100, blur));

  if (b < 0.5) {
    stampBinaryDot(ctx, x, y, radius);
    return;
  }

  if (typeof ctx.fillStyle !== 'string') {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const t = b / 100;
  const outerRadius = radius * (1 + t * AIRBRUSH_SPREAD);
  // Solid core shrinks (in absolute size) toward 0 as blur rises, same as the old
  // radius*(1-t) inner-radius math — expressed here as a fraction of the now-larger
  // outerRadius so the core scales down relative to the spreading halo.
  const coreFraction = Math.max(0, Math.min(0.98, ((1 - t) * radius) / outerRadius));

  ctx.beginPath();
  ctx.arc(x, y, outerRadius, 0, Math.PI * 2);

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, outerRadius);
  gradient.addColorStop(0, ctx.fillStyle);
  gradient.addColorStop(coreFraction, ctx.fillStyle);

  // Feather the halo with several stops on a quadratic falloff (rather than one linear
  // stop straight to alpha 0) for a hazier, more gradual cloud instead of a sharp cone.
  const FEATHER_STEPS = 5;
  for (let i = 1; i <= FEATHER_STEPS; i++) {
    const stepT = i / FEATHER_STEPS;
    const pos = coreFraction + (1 - coreFraction) * stepT;
    const alpha = Math.pow(1 - stepT, 2);
    gradient.addColorStop(Math.min(1, pos), toAlphaColor(ctx.fillStyle, alpha));
  }

  const solidFillStyle = ctx.fillStyle;
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.fillStyle = solidFillStyle;
}

// Stamps filled circles along the (fromX,fromY)-(toX,toY) segment, spaced by
// spacingPct% of the stamp diameter. distanceAcc carries leftover distance from
// the previous call (for continuity across a multi-segment stroke) and the
// updated value is returned for the caller to pass into the next call.
//
// The radius is linearly interpolated per-stamp from fromRadius to toRadius (not held fixed
// for the whole segment) so a size that's changing continuously — e.g. driven by pressure —
// tapers smoothly instead of jumping to a new radius only once per caller-side sample. Pass
// the same value for both when the radius isn't changing.
function stampAlongPath(ctx, fromX, fromY, toX, toY, fromRadius, toRadius, spacingPct, distanceAcc, blur = 0) {
  const maxRadius = Math.max(fromRadius, toRadius);
  if (maxRadius <= 0) return { distanceAcc, count: 0 };

  const step = Math.max(0.5, maxRadius * 2 * (spacingPct / 100));
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { distanceAcc, count: 0 };

  let acc = distanceAcc + distance;
  let stamped = 0;
  while (acc >= step) {
    stamped += 1;
    const distFromStart = step * stamped - distanceAcc;
    const ratio = Math.max(0, Math.min(1, distFromStart / distance));
    const radius = fromRadius + (toRadius - fromRadius) * ratio;
    stampDot(ctx, fromX + dx * ratio, fromY + dy * ratio, radius, blur);
    acc -= step;
  }

  return { distanceAcc: acc, count: stamped };
}

  window.DrawEngine = {
    createLayerCanvas,
    resizeCanvasPreservingContent,
    compositeLayers,
    pointerToCanvasPoint,
    stampDot,
    stampAlongPath,
  };
})();

