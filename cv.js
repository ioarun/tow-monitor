/* Core-exposure detection, in plain JS.
 *
 * A port of poc/roi.py + poc/fit_roi_auto.py with no dependencies, so the whole
 * pipeline can run in Safari on the iPad with no server behind it. OpenCV.js
 * would have been the obvious route and is the wrong one here: 8 MB to download
 * over a hotspot to replace maybe 200 lines of array arithmetic.
 *
 * Deliberately not ported: ORB registration. It kept the ROI on the barrel when
 * the camera was nudged mid-run, and it is by far the heaviest thing in the
 * Python pipeline. This version calibrates per session instead -- the camera is
 * fixed while a session runs, and a knock means recalibrating rather than
 * silently drifting. driftCheck() below is the cheap consolation prize: it does
 * not correct for movement, it notices it and says so.
 *
 * No DOM, no globals: the page uses it and so does tools/check-cv.js, which is
 * what proves these numbers still match the Python they came from.
 */

const GAIN_MIN = 40;        // warmth points a pixel must gain to count as newly bare
const CREAM_WARM = 45;      // absolute warmth of bare core
const BAND_FRACTION = 0.85; // shrink off the shaded, foreshortened limb of the cylinder
const OPEN_KERNEL_REF = 21; // at REF_HEIGHT; speckle removal on the gain mask
const REF_HEIGHT = 3840;
const MIN_BLOB_FRAC = 0.0024;
const BASELINE_MAX = 2.0;   // % a full bobbin may read before the fit is suspect
const CEILING_MIN = 40.0;   // % a bare core must reach for the signal to exist
const ASPECT_TOLERANCE = 0.02;   // 2% — covers rounding, not a real reframing

/* Longest side the analysis runs at. An iPad records at 1080p or 4K, and
 * calibrate() touches every pixel twice for the opening and once more for the
 * flood fill -- at 4K that is 8.3 M pixels and several seconds of a frozen UI.
 * Downscaling is free here only because the geometry is stored as fractions of
 * the frame: fit at 1280 and the same calibration still describes the 4K frame.
 * Calibration and measurement must use the same cap or the ROI's pixel count,
 * and every percentage built on it, quietly shifts. */
const ANALYSIS_MAX = 1280;

/* Dimensions to analyse at, preserving aspect. Never scales up: a 576-wide
 * clip is already cheap and interpolating it larger would invent detail. */
function fitInto(width, height, max = ANALYSIS_MAX) {
  const k = Math.min(1, max / Math.max(width, height));
  return [Math.round(width * k), Math.round(height * k)];
}

/* A calibration only describes frames shaped like the ones it was fitted on.
 * Worth an explicit check because the failure is silent otherwise: calibrate
 * from a portrait clip, monitor with the landscape camera, and the rectangle
 * lands somewhere on the machine and reports a confident number about it. */
function aspectMismatch(cal, width, height) {
  const got = width / height;
  if (Math.abs(got - cal.aspect) <= ASPECT_TOLERANCE * cal.aspect) return null;
  const name = r => (r >= 1 ? "landscape" : "portrait") + ` ${r.toFixed(2)}:1`;
  return `This source is ${name(got)} but the calibration was fitted on ` +
         `${name(cal.aspect)}. Recalibrate from a clip shot the same way round.`;
}

/* Lengths tuned at 4K have to be rescaled or they mean something different at
 * every other resolution -- a fixed kernel erodes four times as hard on a
 * half-size frame. */
function scaled(value, height, minimum = 3, odd = false) {
  let v = Math.max(minimum, Math.round((value * height) / REF_HEIGHT));
  return odd && v % 2 === 0 ? v + 1 : v;
}

/* R - B, in Int16. The tan core is warm and the tow is not, even though the tow
 * is usually the brighter of the two -- which is why this is not a luminance
 * test. Int16 matters: unsigned subtraction wraps and silently inverts the mask. */
function warmth(imageData) {
  const { data, width, height } = imageData;
  const out = new Int16Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = data[p] - data[p + 2];
  return out;
}

/* Binary opening with a square element, as erode-then-dilate. Separable: a
 * square min-filter is a horizontal pass followed by a vertical one, which
 * turns O(k^2) per pixel into O(k). */
function openBinary(mask, width, height, k) {
  const r = (k - 1) >> 1;
  const pass = (src, erode) => {
    const tmp = new Uint8Array(src.length), dst = new Uint8Array(src.length);
    const pick = erode ? (a, b) => a & b : (a, b) => a | b;
    const seed = erode ? 1 : 0;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let v = seed;
        for (let d = -r; d <= r; d++) {
          const xx = x + d;
          if (xx < 0 || xx >= width) { if (erode) { v = 0; break; } continue; }
          v = pick(v, src[row + xx]);
        }
        tmp[row + x] = v;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = seed;
        for (let d = -r; d <= r; d++) {
          const yy = y + d;
          if (yy < 0 || yy >= height) { if (erode) { v = 0; break; } continue; }
          v = pick(v, tmp[yy * width + x]);
        }
        dst[y * width + x] = v;
      }
    }
    return dst;
  };
  return pass(pass(mask, true), false);
}

/* Largest 8-connected blob, as an explicit stack flood fill. Recursion would
 * overflow: a blob here runs to tens of thousands of pixels. */
function largestComponent(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let best = null, bestSize = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0, size = 0;
    const px = [];
    stack[sp++] = start; seen[start] = 1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width, y = (idx / width) | 0;
      px.push(x, y); size++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) { seen[n] = 1; stack[sp++] = n; }
        }
      }
    }
    if (size > bestSize) { bestSize = size; best = px; }
  }
  if (!best) throw new Error("no candidate region found in the frame");
  return { points: best, size: bestSize };
}

/* Principal axis of a point cloud, closed form. A 2x2 symmetric eigenproblem
 * has an exact solution; an iterative solver here would be ceremony. */
function principalAxis(points) {
  const n = points.length / 2;
  let mx = 0, my = 0;
  for (let i = 0; i < points.length; i += 2) { mx += points[i]; my += points[i + 1]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < points.length; i += 2) {
    const dx = points[i] - mx, dy = points[i + 1] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  sxx /= n; sxy /= n; syy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const lambda = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));   // larger root
  let ux, uy;
  if (Math.abs(sxy) > 1e-9) { ux = lambda - syy; uy = sxy; }
  else { ux = sxx >= syy ? 1 : 0; uy = sxx >= syy ? 0 : 1; }
  const len = Math.hypot(ux, uy) || 1;
  return { mean: [mx, my], u: [ux / len, uy / len] };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* --- the ROI ------------------------------------------------------------
 * Geometry is stored as fractions of the frame, never pixels: a pixel
 * calibration only works at the resolution it was fitted at, so every change of
 * camera or transcode would force a refit. x is a fraction of width, y and all
 * lengths a fraction of height -- exact whenever the aspect ratio is preserved,
 * which is why the aspect is stored and checked. */
function toRect(cal, width, height) {
  const p1 = [cal.p1[0] * width, cal.p1[1] * height];
  const p2 = [cal.p2[0] * width, cal.p2[1] * height];
  const hw = cal.halfWidth * height;
  const ux = p2[0] - p1[0], uy = p2[1] - p1[1];
  const L = Math.hypot(ux, uy) || 1;
  return { p1, u: [ux / L, uy / L], n: [-uy / L, ux / L], L, hw };
}

function rectCorners(r) {
  const [ax, ay] = r.p1;
  const bx = ax + r.u[0] * r.L, by = ay + r.u[1] * r.L;
  const nx = r.n[0] * r.hw, ny = r.n[1] * r.hw;
  return [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
}

/* Fraction of the rectangle reading as bare core. Walks the rectangle's
 * bounding box and rejects on two dot products, rather than rasterising a mask
 * -- the ROI is a percent or two of the frame, so touching the whole image per
 * frame would dominate the cost at 2 fps on a tablet. */
function measure(imageData, cal) {
  const { width, height } = imageData;
  const r = toRect(cal, width, height);
  const cs = rectCorners(r);
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[0]))));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...cs.map(c => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[1]))));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...cs.map(c => c[1]))));
  const d = imageData.data;
  let inside = 0, warm = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - r.p1[0], dy = y - r.p1[1];
      const t = dx * r.u[0] + dy * r.u[1];
      if (t < 0 || t > r.L) continue;
      const s = dx * r.n[0] + dy * r.n[1];
      if (s < -r.hw || s > r.hw) continue;
      inside++;
      const p = (y * width + x) * 4;
      if (d[p] - d[p + 2] > CREAM_WARM) warm++;
    }
  }
  return inside ? (100 * warm) / inside : null;
}

/* --- calibration --------------------------------------------------------
 * Two frames of one run: full bobbin, then bare core. The tow-bearing surface
 * is whatever GAINED warmth between them. That is the entire trick, and it is
 * what makes the end caps a non-issue -- they are cream in both frames, so they
 * gain nothing and fall out of the region without being searched for. */
function calibrate(wound, bare, { verbose = false } = {}) {
  const { width, height } = wound;
  if (bare.width !== width || bare.height !== height)
    throw new Error(`frames differ in size: ${width}x${height} vs ${bare.width}x${bare.height}`);

  const a = warmth(wound), b = warmth(bare);
  const gainMask = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) gainMask[i] = b[i] - a[i] > GAIN_MIN ? 1 : 0;

  const opened = openBinary(gainMask, width, height, scaled(OPEN_KERNEL_REF, height, 3, true));
  const { points, size } = largestComponent(opened, width, height);

  const minBlob = MIN_BLOB_FRAC * width * height;
  if (size < minBlob) {
    // The usual cause is auto white balance neutralising the warm tube, and the
    // warmth percentiles say immediately whether that is what happened.
    const sorted = Array.from(b).sort((x, y) => x - y);
    const p99 = percentile(sorted, 0.99);
    throw new Error(
      `Only ${size.toLocaleString()} px gained warmth, need ${Math.round(minBlob).toLocaleString()}. ` +
      `Warmth in the end frame reaches ${Math.round(p99)} at p99 (bare core reads above ${CREAM_WARM}). ` +
      (p99 < CREAM_WARM * 1.5
        ? "The tube is not reading as warm — most likely the camera's auto white balance. Lock exposure and white balance before recording."
        : "Some warm pixels exist but too few — is the core actually showing in the last frame?"));
  }

  const { mean, u } = principalAxis(points);
  let tMin = Infinity, tMax = -Infinity;
  const perp = [];
  for (let i = 0; i < points.length; i += 2) {
    const dx = points[i] - mean[0], dy = points[i + 1] - mean[1];
    const t = dx * u[0] + dy * u[1];
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    perp.push(Math.abs(dx * -u[1] + dy * u[0]));
  }
  perp.sort((x, y) => x - y);
  const halfWidth = percentile(perp, 0.97) * BAND_FRACTION;

  let p1 = [mean[0] + u[0] * tMin, mean[1] + u[1] * tMin];
  let p2 = [mean[0] + u[0] * tMax, mean[1] + u[1] * tMax];

  const cal = {
    p1: [p1[0] / width, p1[1] / height],
    p2: [p2[0] / width, p2[1] / height],
    halfWidth: halfWidth / height,
    aspect: width / height,
    fittedAt: [width, height],
    gainPx: size,
    angleDeg: ((Math.atan2(u[1], u[0]) * 180) / Math.PI + 180) % 180,
  };

  // Verify before returning. These bounds do not steer the fit; they reject a
  // calibration that would be useless downstream, with a reason a human can act on.
  const lo = measure(wound, cal), hi = measure(bare, cal);
  cal.baselinePct = Math.round(lo * 100) / 100;
  cal.ceilingPct = Math.round(hi * 10) / 10;
  if (verbose) console.log(`gain ${size} px, baseline ${lo.toFixed(2)}%, ceiling ${hi.toFixed(1)}%`);

  if (lo > BASELINE_MAX)
    throw new Error(`The first frame reads ${lo.toFixed(1)}% inside the fitted region, above the ` +
      `${BASELINE_MAX}% noise floor. Something cream was already there — check the first frame ` +
      `really shows a full bobbin.`);
  if (hi < CEILING_MIN)
    throw new Error(`The last frame only reads ${hi.toFixed(1)}%, below the ${CEILING_MIN}% needed ` +
      `for a usable signal. Let the recording run until the core is properly showing.`);
  return cal;
}

/* Does this frame still look like the one we calibrated on? Compares coarse
 * grayscale over the whole frame, which is enough to catch a knocked tripod.
 * It cannot correct for movement -- saying "recalibrate" is the honest response
 * when the alternative is measuring the wrong rectangle and believing it. */
function driftCheck(refSmall, imageData, gridW = 32, gridH = 18) {
  const s = downsampleGray(imageData, gridW, gridH);
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += Math.abs(s[i] - refSmall[i]);
  return sum / s.length;            // mean absolute difference, 0..255
}

function downsampleGray(imageData, gw, gh) {
  const { data, width, height } = imageData;
  const out = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy * height) / gh), y1 = Math.floor(((gy + 1) * height) / gh);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * width) / gw), x1 = Math.floor(((gx + 1) * width) / gw);
      let acc = 0, n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const p = (y * width + x) * 4;
          acc += (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
          n++;
        }
      }
      out[gy * gw + gx] = n ? acc / n : 0;
    }
  }
  return out;
}

const CV = { GAIN_MIN, CREAM_WARM, BAND_FRACTION, BASELINE_MAX, CEILING_MIN,
             ASPECT_TOLERANCE, ANALYSIS_MAX,
             warmth, openBinary, largestComponent, principalAxis, percentile,
             fitInto, aspectMismatch,
             toRect, rectCorners, measure, calibrate, driftCheck, downsampleGray };

if (typeof module !== "undefined" && module.exports) module.exports = CV;
if (typeof window !== "undefined") window.CV = CV;
