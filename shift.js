/* Shift tracking: an append-only event log, and everything derived from it.
 *
 * A SHIFT is one Start to one End -- the operator's working stretch. Inside it
 * are RUNS, one per scrap bobbin consumed, and any number of COMPLETED bobbins
 * finished on the rewinder. Those are three different things, and calling all
 * of them "a session" is what made the first draft of this confusing.
 *
 * Design and reasoning: docs/shift-tracking.md. The short version is that the
 * log is the record and the numbers are a view of it. Counters are not stored,
 * because the rules that produce them will be wrong at first -- the definition
 * of idle time already changed once during design -- and a rule applied to
 * stored events can be re-run, where a rule applied to stored summaries has
 * thrown away what it was computed from.
 *
 * This lives beside cv.js rather than in the page's inline script so the tests
 * can import it. tests/README.md records what the inline script has cost: the
 * decision logic there is mirrored by hand in the tests, with a comment saying
 * what happens when the two drift, and they did drift. The derivation below is
 * the part most likely to be wrong, so it is the part that must be testable
 * without a browser, a camera or a trip to the machine.
 */

const EV = {
  SHIFT_STARTED:          "shift.started",         // { shiftNo, name }
  SHIFT_ENDED:            "shift.ended",           // { peakPct }
  RUN_STARTED:            "run.started",
  RUN_RESET:              "run.reset",             // { peakPct } -- of the run it closes
  MOTION_STARTED:         "motion.started",        // { level }
  MOTION_STOPPED:         "motion.stopped",
  DEPLETION_ALERTED:      "depletion.alerted",     // { pct }
  DEPLETION_ACKNOWLEDGED: "depletion.acknowledged",
  STOP_ALERTED:           "stop.alerted",
  STOP_CLEARED:           "stop.cleared",          // { heldFor }
  BOBBIN_COMPLETED:       "bobbin.completed",      // { peakPct }
  CALIBRATION_APPLIED:    "calibration.applied",   // { baseline, ceiling, creamWarm }
};

/* A run that ended with no alert is either one we failed to warn about or one
 * the operator pulled off early, and those must not be counted together: the
 * second inflates the project's own false-negative rate, in the direction that
 * flatters nothing and is discovered late. The exposure reading separates them
 * without asking anyone. 50% is far above any plausible alert threshold (the
 * default is 5) and far above a bobbin that never got near depleting. */
const MISS_ABOVE_PCT = 50;

/* What closes a RUN -- one scrap bobbin. Finishing a rewound bobbin is NOT on
 * this list: the rewinder reaching weight has nothing to do with the scrap
 * bobbin feeding it, which usually still has tow on it and carries straight on
 * into the next one. They are independent events that happen to be adjacent. */
const CLOSERS = [EV.RUN_RESET, EV.SHIFT_ENDED];

const sum = xs => xs.reduce((a, b) => a + b, 0);
const secs = ms => Math.round(ms / 100) / 10;      // one decimal, in seconds

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Motion intervals across the whole shift. Built once and then sliced per
 * run, rather than per run, so a run boundary can be snapped onto them. */
function motionIntervals(events, endT) {
  const out = [];
  let open = null;
  for (const e of events) {
    if (e.type === EV.MOTION_STARTED && open === null) open = e.t;
    else if (e.type === EV.MOTION_STOPPED && open !== null) { out.push({ start: open, end: e.t }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: endT, openEnded: true });
  return out;
}

/* Where one scrap bobbin ends and the next begins.
 *
 * Reset is the operator saying a swap happened, which is true however the last
 * bobbin ended -- depleted, abandoned mid-fault, tow broken. But it is pressed
 * a few seconds AFTER the next bobbin is already turning, so the press is not
 * the moment. The boundary snaps to the machine: close at the last stop before
 * the press, open at the start that followed it. Those few seconds then land in
 * the new run instead of being added to the old one.
 *
 * A Reset with no stop in between is a mis-press; the boundary falls where it
 * was pressed, which keeps the runs in order and loses nothing. */
function boundary(closer, intervals) {
  const before = intervals.filter(i => i.end <= closer.t);
  const closeAt = before.length ? before[before.length - 1].end : closer.t;
  const resumed = intervals.find(i => i.start > closeAt && i.start <= closer.t);
  return { closeAt, openAt: resumed ? resumed.start : closer.t };
}

function overlap(interval, from, to) {
  const a = Math.max(interval.start, from), b = Math.min(interval.end, to);
  return b > a ? { start: a, end: b } : null;
}

/* events -> { shift, runs }. Pure: no clock, no storage, no DOM.
 * `now` is only used to close a shift that is still open. */
function derive(events, { now = null, missAbovePct = MISS_ABOVE_PCT } = {}) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  if (!ev.length) return { shift: null, runs: [] };

  const started = ev.find(e => e.type === EV.SHIFT_STARTED);
  const ended = ev.find(e => e.type === EV.SHIFT_ENDED);
  const startedAt = started ? started.t : ev[0].t;
  const endedAt = ended ? ended.t : null;
  const horizon = endedAt ?? now ?? ev[ev.length - 1].t;

  const intervals = motionIntervals(ev, horizon);
  const closers = ev.filter(e => CLOSERS.includes(e.type));

  /* One run per closer, plus a trailing open run if the shift is still going.
   * Runs are cut on the motion timeline; the closers only say where. */
  const cuts = closers.map(c => ({ closer: c, ...boundary(c, intervals) }));
  const runs = [];
  let openAt = (ev.find(e => e.type === EV.RUN_STARTED) || { t: startedAt }).t;

  const build = (from, to, closer) => {
    const mine = ev.filter(e => e.t >= from && e.t <= to);
    const spans = intervals.map(i => overlap(i, from, to)).filter(Boolean);
    const alert = mine.find(e => e.type === EV.DEPLETION_ALERTED);
    const ack = mine.find(e => e.type === EV.DEPLETION_ACKNOWLEDGED);
    const lastStop = spans.length ? spans[spans.length - 1].end : null;
    const peakPct = closer && typeof closer.peakPct === "number" ? closer.peakPct
                  : alert ? alert.pct : null;

    /* Every motion gap inside a run is the machine stopping and being
     * restarted on the same bobbin -- a tow-width fault, in practice. The run's
     * own final stop is not one of them. */
    const faultGaps = spans.slice(0, -1).map((s, i) => spans[i + 1].start - s.end);

    return {
      seq: runs.length + 1,
      startedAt: from,
      endedAt: to,
      runSeconds: secs(sum(spans.map(s => s.end - s.start))),
      peakPct,
      alertedAt: alert ? alert.t : null,
      alertPct: alert ? alert.pct : null,
      warningSeconds: alert && lastStop !== null ? secs(lastStop - alert.t) : null,
      ackSeconds: alert && ack ? secs(ack.t - alert.t) : null,
      endedBy: alert ? "depleted"
             : (peakPct !== null && peakPct >= missAbovePct) ? "missed" : "abandoned",
      faultStops: faultGaps.length,
      faultStopSeconds: secs(sum(faultGaps)),
      open: !closer,
    };
  };

  for (const cut of cuts) {
    runs.push(build(openAt, cut.closeAt, cut.closer));
    openAt = cut.openAt;
  }
  // a run in progress: everything after the last boundary
  if (!endedAt && openAt < horizon) runs.push(build(openAt, horizon, null));

  // idle is the gap between one run's last motion and the next run's first
  for (let i = 0; i < runs.length - 1; i++) {
    const next = intervals.find(x => x.start >= runs[i].endedAt);
    runs[i].idleAfterSeconds = next ? secs(next.start - runs[i].endedAt) : null;
  }
  if (runs.length) runs[runs.length - 1].idleAfterSeconds = null;

  const closed = runs.filter(r => !r.open);
  const warnings = runs.map(r => r.warningSeconds).filter(x => x !== null);
  const runSec = sum(runs.map(r => r.runSeconds));
  const idleSec = sum(runs.map(r => r.idleAfterSeconds || 0)) + sum(runs.map(r => r.faultStopSeconds));

  return {
    shift: {
      shiftNo: started ? started.shiftNo : null,
      name: started ? (started.name ?? null) : null,
      startedAt, endedAt,
      bobbinsCompleted: ev.filter(e => e.type === EV.BOBBIN_COMPLETED).length,
      scrapBobbins: closed.length,
      totalRunSeconds: Math.round(runSec * 10) / 10,
      totalIdleSeconds: Math.round(idleSec * 10) / 10,
      utilisation: runSec + idleSec > 0 ? Math.round((1000 * runSec) / (runSec + idleSec)) / 10 : null,
      faultStopCount: sum(runs.map(r => r.faultStops)),
      faultStopSeconds: Math.round(sum(runs.map(r => r.faultStopSeconds)) * 10) / 10,
      missedAlerts: runs.filter(r => r.endedBy === "missed").length,
      abandoned: runs.filter(r => r.endedBy === "abandoned").length,
      medianWarningSeconds: median(warnings),
    },
    runs,
  };
}

/* Rows a spreadsheet can open. Data that cannot leave the tablet is not data. */
function toCSV(runs, shift) {
  const cols = ["shift", "shiftName", "bobbin", "runSeconds", "idleAfterSeconds", "peakPct",
                "warningSeconds", "ackSeconds", "endedBy", "faultStops", "faultStopSeconds"];
  const rows = runs.map(r => [
    shift ? shift.shiftNo : "", shift ? (shift.name ?? "") : "",
    r.seq, r.runSeconds, r.idleAfterSeconds ?? "",
    r.peakPct ?? "", r.warningSeconds ?? "", r.ackSeconds ?? "", r.endedBy,
    r.faultStops, r.faultStopSeconds]);
  return [cols.join(","), ...rows.map(r => r.join(","))].join("\n");
}

/* A log that records and nothing else. Keeping it this thin is the point: the
 * app appends, the derivation reads, and neither knows about the other. */
function createLog(shiftNo) {
  const events = [];
  return {
    events,
    add(type, payload = {}, t = Date.now()) {
      const e = { t, type, ...payload };
      events.push(e);
      return e;
    },
    derive(opts) { return derive(events, opts); },
    get shiftNo() { return shiftNo; },
  };
}

const Shift = { EV, MISS_ABOVE_PCT, derive, toCSV, createLog, motionIntervals };

if (typeof module !== "undefined" && module.exports) module.exports = Shift;
if (typeof window !== "undefined") window.Shift = Shift;
