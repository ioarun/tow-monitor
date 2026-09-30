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

/* Both thresholds below are FALLBACKS. They were hand-tuned on one iPad, and
 * an absolute R-B value is a property of that camera's sensor and colour
 * processing, not of carbon tow or cardboard -- which made them the reason the
 * pipeline could not be trusted on a device it had not been tuned against.
 *
 * calibrate() now derives both from the calibration frames by Otsu's method
 * and stores them, so each camera gets its own. These stay as bounds and as
 * the answer when a calibration predates the change. */
const GAIN_MIN = 40;        // fallback: warmth a pixel must gain to count as newly bare
const CREAM_WARM = 45;      // fallback: absolute warmth of bare core
const GAIN_RANGE = [15, 70];    // plausible bounds for the derived gain threshold
const CREAM_RANGE = [15, 95];   // ...and for the derived cream threshold
const BAND_FRACTION = 0.85; // shrink off the shaded, foreshortened limb of the cylinder
const OPEN_KERNEL_REF = 21; // at REF_HEIGHT; speckle removal on the gain mask
const REF_HEIGHT = 3840;
const MIN_BLOB_FRAC = 0.0024;
const BASELINE_MAX = 2.0;   // % a full bobbin may read before the fit is suspect
const CEILING_MIN = 40.0;   // % a bare core must reach for the signal to exist
const CEILING_GOOD = 95.0;  // % preferred when choosing between candidate regions

/* A cylinder seen side-on is far longer than it is wide, so a well-fitted
 * region is too. When the second still is captured before the tow has
 * finished leaving the tube, only part of the barrel has gained warmth and
 * the region comes out nearly square -- and a near-square point cloud has no
 * well-determined principal axis, so PCA's answer stops being a measurement.
 *
 * Measured: vid1, a run that goes fully bare, fits 465 x 42 px, aspect 11.
 * vid2, which stops partway, fits 227 x 118 px, aspect 1.9, and its axis
 * lands 4.7 deg from the barrel's true angle. It still verifies -- the
 * rectangle is on the barrel -- but it covers 40% of it and the axis is
 * luck. Worth saying so rather than letting it pass silently. */
const REGION_ASPECT_MIN = 3.0;
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

/* Otsu's method: the threshold that best splits a distribution into two
 * groups by maximising the variance between them.
 *
 * Kept, but NOT used to choose the cream threshold, and the reason is worth
 * recording. Otsu assumes two separated modes and finds the valley between
 * them. Measured inside the ROI on vid1 there is no valley: the tow reaches
 * 40 at p99 while the tube starts at 19 by p01, so the populations overlap
 * for twenty points. Otsu cut at 28 -- optimal by its own criterion, and
 * wrong here, because our costs are not symmetric. Calling some tube "tow"
 * only lowers the ceiling, which has 98 points to give. Calling some tow
 * "tube" raises the baseline, which is what every alert threshold is
 * measured against. It took the baseline from 0.85% to 3.5%. */
function otsu(values, lo = -255, hi = 255) {
  const bins = hi - lo + 1;
  const hist = new Float64Array(bins);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(values[i]);
    hist[Math.max(lo, Math.min(hi, v)) - lo]++;
    n++;
  }
  if (!n) return 0;
  let total = 0;
  for (let i = 0; i < bins; i++) total += i * hist[i];

  const bc = new Float64Array(bins);      // between-class variance per threshold
  let sumB = 0, wB = 0, best = -1;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    sumB += t * hist[t];
    const wF = n - wB;
    if (!wB || !wF) continue;             // a split with an empty side is not a split
    const mB = sumB / wB, mF = (total - sumB) / wF;
    bc[t] = wB * wF * (mB - mF) * (mB - mF);
    if (bc[t] > best) best = bc[t];
  }
  if (best <= 0) return 0;

  /* Take the middle of the optimum, not its first element. When the two modes
   * are cleanly separated the valley between them is empty, so every threshold
   * inside it scores identically -- and returning the first puts the cut hard
   * against the darker mode, where a little sensor noise carries pixels across
   * it. The midpoint is the same optimum with margin on both sides. */
  let loT = bins, hiT = 0;
  for (let t = 0; t < bins; t++)
    if (bc[t] >= best * 0.999) { if (t < loT) loT = t; if (t > hiT) hiT = t; }
  return Math.round((loT + hiT) / 2) + lo;
}

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

/* The cream threshold, derived from the frame that must read zero.
 *
 * Not from the separation between tow and tube -- from the tow alone. Sit
 * just above what a full bobbin reads and the baseline is near zero by
 * construction, on whatever camera is in front of you, which is the property
 * the whole measurement rests on. Whether the tube clears it is then checked
 * by CEILING_MIN rather than assumed.
 *
 * WOUND_QUANTILE is the fraction of a full bobbin allowed above the
 * threshold, and it buys baseline with ceiling. Measured on vid1 at the
 * region the old constants produced:
 *
 *   q=0.980  cream>26   1.90% ->  100%
 *   q=0.990  cream>44   0.92% ->  100%     <- and 45 was the hand-tuned value
 *   q=0.995  cream>60   0.38% ->   62%
 *
 * Past 0.99 the threshold climbs into the tube's own distribution and starts
 * discarding the signal to chase a baseline that is already negligible
 * against a 10% alert. */
const WOUND_QUANTILE = 0.99;

function creamThresholdFor(wound, cal) {
  const w = roiWarmthValues(wound, cal).sort((a, b) => a - b);
  return clamp(Math.round(percentile(w, WOUND_QUANTILE)) + 1, CREAM_RANGE);
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
  const warmAt = cal.creamWarm ?? CREAM_WARM;   // older calibrations have no derived value
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
      if (d[p] - d[p + 2] > warmAt) warm++;
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
  const gain = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) gain[i] = b[i] - a[i];

  /* No fixed gain threshold transfers between cameras. A robust noise scale
   * gets the order of magnitude right but not the value: median + 8 sigma is
   * 41 on one of our clips and 59 on the other, and only one of those works.
   *
   * So do not derive it -- search it. Candidates are spaced in units of this
   * camera's own noise, and each is judged by the checks the calibration has
   * to pass anyway. Using the acceptance test as the objective means the
   * answer is right by the same standard it will later be judged by, on any
   * camera, rather than right according to a proxy that held on ours.
   *
   * The objective is COVERAGE, subject to a clean baseline and a real
   * ceiling. Scoring on separation instead looks tempting and is a trap: it
   * picked a 1,880 px patch in the middle of the tube, which reads 0% to
   * 99.9% and is a perfect score for a region covering almost none of the
   * barrel. The widest span and the most useful region are not the same
   * thing, and only one of them measures depletion. */
  const sigma = madSigma(gain);
  const candidates = [...new Set([4, 6, 8, 10, 12]
    .map(k => clamp(Math.round(sigma.median + k * sigma.scale), GAIN_RANGE)))];

  let best = null;
  for (const gainAt of candidates) {
    const m = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) m[i] = gain[i] > gainAt ? 1 : 0;
    let attempt;
    try {
      const opened = openBinary(m, width, height, scaled(OPEN_KERNEL_REF, height, 3, true));
      attempt = largestComponent(opened, width, height);
    } catch { continue; }                       // nothing found at this threshold
    if (attempt.size < MIN_BLOB_FRAC * width * height) { best = best || { gainAt, ...attempt, thin: true }; continue; }
    const trial = regionFrom(attempt.points, width, height);
    trial.creamWarm = creamThresholdFor(wound, trial);
    const lo = measure(wound, trial), hi = measure(bare, trial);
    if (verbose) console.log(`  gain>${gainAt}: ${attempt.size} px, cream>${trial.creamWarm}, ` +
      `${lo.toFixed(2)}% -> ${hi.toFixed(1)}%`);
    if (lo > BASELINE_MAX || hi < CEILING_MIN) continue;
    /* Coverage, but not at the cost of range. Maximising size alone picked a
     * region 3.4x larger whose ceiling had collapsed to 61%, because it had
     * spread past the barrel onto surfaces that never turn warm. Prefer every
     * candidate that keeps a near-full ceiling, and only among those take the
     * largest; fall back to merely acceptable ones if none qualifies. */
    const tier = hi >= CEILING_GOOD ? 1 : 0;
    if (!best || best.thin || tier > best.tier ||
        (tier === best.tier && attempt.size > best.size))
      best = { gainAt, ...attempt, trial, lo, hi, tier };
  }
  if (!best) best = { gainAt: candidates[0], points: [], size: 0, thin: true };
  const { gainAt, points, size } = best;

  const minBlob = MIN_BLOB_FRAC * width * height;
  if (size < minBlob) {
    /* Say which of three different problems this is. The previous version
     * blamed auto white balance whenever the frame was not very warm, which
     * is also true of a frame containing no tube at all -- so it confidently
     * misdiagnosed the most common setup mistake, and did so on exactly the
     * unfamiliar device where the operator cannot tell it is wrong. */
    const warmSorted = Array.from(b).sort((x, y) => x - y);
    const p99 = percentile(warmSorted, 0.99);
    const sceneDiff = meanAbsDiff(downsampleGray(bare, 32, 18), downsampleGray(wound, 32, 18));
    const head = `Only ${size.toLocaleString()} px gained warmth, need ` +
                 `${Math.round(minBlob).toLocaleString()}. `;

    if (sceneDiff < 2)
      throw new Error(head + `The two stills are almost identical (scene difference ` +
        `${sceneDiff.toFixed(1)}). Capture the second one after the core is actually showing — ` +
        `at the end of a run, or with an empty tube swapped into the same place.`);
    if (p99 < 25)
      throw new Error(head + `Nothing in the second still is warm: the warmest 1% of the frame ` +
        `only reaches ${Math.round(p99)}, where bare cardboard reads well above that. Either the ` +
        `tube is not in shot, or the camera's auto white balance has neutralised it — check the ` +
        `thumbnail shows the tube, then lock exposure and white balance.`);
    throw new Error(head + `The frame does contain warm pixels (p99 ${Math.round(p99)}) but few of ` +
      `them changed between the two stills. Are both framed on the same bobbin, and does the ` +
      `second one show bare tube where the first showed tow?`);
  }

  const cal = regionFrom(points, width, height);
  cal.gainPx = size;
  cal.gainAt = gainAt;

  /* Derive this camera's cream threshold from the two frames, inside the
   * region just fitted. Those pixels are black tow in one frame and bare tube
   * in the other -- as cleanly bimodal as this problem ever gets -- so Otsu
   * lands in the valley between them.
   *
   * This is what makes the pipeline portable. An absolute R-B cut is a fact
   * about one sensor's colour processing, not about carbon and cardboard, so
   * a hand-tuned constant silently measures the wrong thing on any camera it
   * was not tuned against. Derived per calibration, each device gets its own. */
  cal.creamWarm = creamThresholdFor(wound, cal);

  const rr = toRect(cal, width, height);
  cal.regionAspect = Math.round((rr.L / (2 * rr.hw)) * 10) / 10;

  // Verify before returning. These bounds do not steer the fit; they reject a
  // calibration that would be useless downstream, with a reason a human can act on.
  const lo = measure(wound, cal), hi = measure(bare, cal);
  cal.baselinePct = Math.round(lo * 100) / 100;
  cal.ceilingPct = Math.round(hi * 10) / 10;
  if (verbose) console.log(`gain ${size} px @>${gainAt}, cream >${cal.creamWarm}, ` +
    `baseline ${lo.toFixed(2)}%, ceiling ${hi.toFixed(1)}%`);

  if (lo > BASELINE_MAX)
    throw new Error(`The first frame reads ${lo.toFixed(1)}% inside the fitted region, above the ` +
      `${BASELINE_MAX}% noise floor. Something cream was already there — check the first frame ` +
      `really shows a full bobbin.`);
  if (hi < CEILING_MIN)
    throw new Error(`The last frame only reads ${hi.toFixed(1)}%, below the ${CEILING_MIN}% needed ` +
      `for a usable signal. Let the recording run until the core is properly showing.`);

  // Usable, but say so: the numbers will be right and the region will be small.
  if (cal.regionAspect < REGION_ASPECT_MIN)
    cal.warning = `Only part of the tube was bare in the second still, so the fitted region ` +
      `is stubby (${cal.regionAspect}:1) and covers less of the barrel than it could. It will ` +
      `work, but capturing once the whole tube is showing gives a better region.`;
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

/* --- motion, for detecting that the machine has stopped -----------------
 * The bobbin turning is the only thing in the ROI that changes, so frame
 * differencing there measures whether the machine is running.
 *
 * Differencing the ROI alone does not work: auto-exposure steps, a knock, a
 * cloud over a skylight all move every pixel in the frame at once, and read
 * as motion. The fix is to difference a second region that cannot move and
 * subtract it. The whole-frame 32x18 grid serves, and needs no per-framing
 * setup -- the ROI is a few percent of the frame, so the grid is dominated
 * by things that stay put, which makes it a measure of the common mode.
 *
 * Measured on two clips of a running machine (~10 min, 1204 samples at
 * 2 fps): net motion ran at a median of 2.3-2.75, and the longest stretch
 * that fell below 1.0 was 5.5 s. So STOP_BELOW sits about 2.5x under the
 * running signal and STOP_HOLD nearly 3x past the longest quiet patch the
 * footage produced.
 *
 * The hold is set by what a false alarm costs, not by how fast detection
 * could be. The PRD allows 60 s to notice a stop and says idle time is the
 * only cost -- while a fault alert that cries wolf gets muted, and it shares
 * a channel with the depletion alert, so muting it disables that too. Buying
 * margin with latency is therefore almost free, and 15 s spends a quarter of
 * the budget to nearly triple the margin. */
const STOP_BELOW = 1.0;     // FALLBACK only — see stopThresholdFrom()
const STOP_HOLD = 15;       // seconds it must stay there

/* The stop threshold cannot be a constant either, for the same reason the
 * colour thresholds could not be: it is a grey-level difference, so it is a
 * property of the sensor's noise rather than of the machine.
 *
 * Measured on a static scene: the iPad reads a median net motion of 0.00,
 * while an Android tablet reads 0.69 in one clip and 1.57 in another -- two
 * recordings of the same stationary rig, minutes apart. At STOP_BELOW = 1.0
 * the second of those reads as "still moving", so a genuinely stopped machine
 * would never be reported.
 *
 * So learn it instead, from the machine running. Take the median net motion
 * over the first MOTION_WARMUP seconds of a run and call a fraction of it
 * "stopped". On the iPad the running median was 2.3-2.75, and the 1.0 that
 * gave zero false alarms over ten minutes is 0.4 of that -- so the fraction
 * is set to reproduce the one setting that has been properly validated. */
const STOP_FRACTION = 0.4;   // of the running level
const STOP_FLOOR = 0.4;      // never arm below this, whatever was measured
const RUNNING_MIN = 0.8;     // below this the machine was not running to begin with

/* Running level -> the threshold to call it stopped, or null when the warm-up
 * saw nothing moving. Null means do not arm: a detector that learned its
 * baseline from an already-stopped machine would never fire, and would look
 * exactly like one that was working. */
function stopThresholdFrom(runningLevel) {
  if (!(runningLevel > RUNNING_MIN)) return null;
  return Math.max(STOP_FLOOR, runningLevel * STOP_FRACTION);
}

/* Grey samples inside the ROI's bounding box, subsampled by 2. Not masked to
 * the rotated rectangle: the bounding box is cheaper, and for a difference
 * the few corner pixels of background are common-mode anyway. */
function roiGray(imageData, cal, step = 2) {
  const { data, width, height } = imageData;
  const r = toRect(cal, width, height);
  const cs = rectCorners(r);
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[0]))));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...cs.map(c => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[1]))));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...cs.map(c => c[1]))));
  const out = [];
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      const p = (y * width + x) * 4;
      out.push((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000);
    }
  return Float32Array.from(out);
}

/* A blob of points -> the rotated rectangle covering it, as a calibration.
 * Called once per candidate threshold during the search and once more for the
 * winner, so it must stay free of side effects. */
function regionFrom(points, width, height) {
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
  const p1 = [mean[0] + u[0] * tMin, mean[1] + u[1] * tMin];
  const p2 = [mean[0] + u[0] * tMax, mean[1] + u[1] * tMax];
  return {
    p1: [p1[0] / width, p1[1] / height],
    p2: [p2[0] / width, p2[1] / height],
    halfWidth: halfWidth / height,
    aspect: width / height,
    fittedAt: [width, height],
    angleDeg: ((Math.atan2(u[1], u[0]) * 180) / Math.PI + 180) % 180,
  };
}

/* Warmth of every pixel inside the ROI's bounding rectangle. Used to derive
 * the cream threshold, so it deliberately walks the rotated rectangle rather
 * than its bounding box: background in the corners would pull the histogram. */
function roiWarmthValues(imageData, cal, step = 2) {
  const { data, width, height } = imageData;
  const r = toRect(cal, width, height);
  const cs = rectCorners(r);
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[0]))));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...cs.map(c => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[1]))));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...cs.map(c => c[1]))));
  const out = [];
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      const dx = x - r.p1[0], dy = y - r.p1[1];
      const t = dx * r.u[0] + dy * r.u[1];
      if (t < 0 || t > r.L) continue;
      const sN = dx * r.n[0] + dy * r.n[1];
      if (sN < -r.hw || sN > r.hw) continue;
      const p = (y * width + x) * 4;
      out.push(data[p] - data[p + 2]);
    }
  return out;
}

/* Robust noise scale: most of a gain image is pixels that did not change, so
 * the median absolute deviation measures the camera rather than the subject.
 * 1.4826 converts MAD to the standard deviation of an equivalent normal. */
function madSigma(values) {
  const v = Array.from(values).sort((x, y) => x - y);
  const median = v[v.length >> 1];
  const dev = v.map(x => Math.abs(x - median)).sort((x, y) => x - y);
  return { median, scale: Math.max(1, dev[dev.length >> 1] * 1.4826) };
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/* Motion of the ROI above and beyond whatever moved the whole frame.
 * Clamped at zero: a negative result means the frame changed more than the
 * ROI did, which is a lighting event, not the machine running backwards. */
function netMotion(roiNow, roiPrev, gridNow, gridPrev) {
  const a = meanAbsDiff(roiNow, roiPrev), b = meanAbsDiff(gridNow, gridPrev);
  if (a === null || b === null) return null;
  return Math.max(0, a - b);
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
             ASPECT_TOLERANCE, ANALYSIS_MAX, STOP_BELOW, STOP_HOLD,
             STOP_FRACTION, STOP_FLOOR, RUNNING_MIN, stopThresholdFrom,
             GAIN_RANGE, CREAM_RANGE,
             warmth, openBinary, largestComponent, principalAxis, percentile, otsu,
             roiWarmthValues, regionFrom, madSigma, creamThresholdFor,
             fitInto, aspectMismatch,
             toRect, rectCorners, measure, calibrate, driftCheck, downsampleGray,
             roiGray, meanAbsDiff, netMotion };

if (typeof module !== "undefined" && module.exports) module.exports = CV;
if (typeof window !== "undefined") window.CV = CV;
