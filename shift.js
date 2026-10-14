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
  CARRIED_OVER:           "carried.over",          // { bobbinsCompleted, scrapBobbins, idleSeconds }
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

  /* Changeover: the stopped stretch between a bobbin being finished and the
     machine turning again. The operator is lifting a full bobbin off the
     rewinder, fitting a bare tube and re-threading -- stopped, but not waiting.
     Counting it as idle would make a shift look worse the more bobbins it
     finished, which is exactly backwards.

     It only exists if the machine was ALREADY STOPPED when the bobbin was
     called complete. An earlier version ran the window from the completion to
     the next Reset, which on a completion pressed mid-run swallowed every fault
     stop in between and zeroed the shift's idle time. If the machine is still
     turning, nothing is being changed over yet.

     Reported separately rather than discarded: time the machine spent stopped
     has to land somewhere, or the figures stop adding up to the shift. */
  const stoppedGaps = [];
  for (let i = 0; i < intervals.length - 1; i++)
    stoppedGaps.push({ start: intervals[i].end, end: intervals[i + 1].start });

  const changeovers = [];
  for (const c of ev.filter(e => e.type === EV.BOBBIN_COMPLETED)) {
    const during = stoppedGaps.find(g => c.t >= g.start && c.t < g.end);
    if (during) changeovers.push({ start: c.t, end: during.end });
  }
  const changeoverIn = (from, to) =>
    sum(changeovers.map(c => { const o = overlap(c, from, to); return o ? o.end - o.start : 0; }));

  // a stopped stretch, with any changeover taken out of it
  const netGap = (from, to) => Math.max(0, (to - from) - changeoverIn(from, to));

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
    const faultGaps = spans.slice(0, -1).map((s, i) => netGap(s.end, spans[i + 1].start));

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
    runs[i].idleAfterSeconds = next ? secs(netGap(runs[i].endedAt, next.start)) : null;
  }
  if (runs.length) runs[runs.length - 1].idleAfterSeconds = null;

  /* Per completed bobbin. A shift finishes as many as it finishes, and the
     operator wants to know what each one cost -- so the shift is cut at every
     completion and the motion inside each piece is measured.
     
     Cut on the motion timeline rather than on whole runs, because a bobbin
     usually completes part-way through a scrap bobbin: the run feeding it
     carries on afterwards and its time belongs to both sides of the line. */
  const completions = ev.filter(e => e.type === EV.BOBBIN_COMPLETED);
  const bobbins = completions.map((c, i) => {
    const from = i ? completions[i - 1].t : startedAt;
    const to = c.t;
    const spans = intervals.map(x => overlap(x, from, to)).filter(Boolean);
    const mine = stoppedGaps.filter(g => g.start >= from && g.start < to);
    const run = sum(spans.map(x => x.end - x.start));
    const idle = sum(mine.map(g => netGap(g.start, g.end)));
    const change = changeoverIn(from, to);
    return {
      seq: i + 1,
      startedAt: from, endedAt: to,
      elapsedSeconds: secs(to - from),
      runSeconds: secs(run),
      idleSeconds: secs(idle),
      changeoverSeconds: secs(change),
      // a scrap bobbin counts against whichever bobbin it was used up feeding
      scrapBobbins: runs.filter(r => !r.open && r.endedAt > from && r.endedAt <= to).length,
      utilisation: run + idle > 0 ? Math.round((1000 * run) / (run + idle)) / 10 : null,
    };
  });

  /* Work already done on the bobbin currently on the rewinder, before this
     shift opened. A shift often picks up a part-made bobbin, and without this
     its first completion would report only the fraction done today -- which is
     the one number on that line nobody could sanity-check against the machine.
     The operator types it in; the last value entered wins.

     It belongs to the FIRST bobbin completed this shift, because that is the
     one it was spent on, and to the shift totals. It does not invent runs:
     `runs` stays a record of what this shift actually saw. */
  const carriedEv = ev.filter(e => e.type === EV.CARRIED_OVER).pop();
  const carried = { bobbinsCompleted: carriedEv?.bobbinsCompleted || 0,
                    scrapBobbins: carriedEv?.scrapBobbins || 0,
                    idleSeconds: carriedEv?.idleSeconds || 0 };
  /* Bobbins finished before this shift opened are numbered ahead of the ones
     finished in it, so the operator's count on screen matches the machine's. */
  bobbins.forEach(b => { b.seq += carried.bobbinsCompleted; });
  if (bobbins.length) {
    bobbins[0].scrapBobbins += carried.scrapBobbins;
    bobbins[0].idleSeconds = Math.round((bobbins[0].idleSeconds + carried.idleSeconds) * 10) / 10;
    const r = bobbins[0].runSeconds, i = bobbins[0].idleSeconds;
    bobbins[0].utilisation = r + i > 0 ? Math.round((1000 * r) / (r + i)) / 10 : null;
  }

  const closed = runs.filter(r => !r.open);
  const warnings = runs.map(r => r.warningSeconds).filter(x => x !== null);
  const runSec = sum(runs.map(r => r.runSeconds));
  const idleSec = sum(runs.map(r => r.idleAfterSeconds || 0))
                + sum(runs.map(r => r.faultStopSeconds)) + carried.idleSeconds;

  return {
    shift: {
      shiftNo: started ? started.shiftNo : null,
      name: started ? (started.name ?? null) : null,
      startedAt, endedAt,
      bobbinsCompleted: ev.filter(e => e.type === EV.BOBBIN_COMPLETED).length
                        + (ev.filter(e => e.type === EV.CARRIED_OVER).pop()?.bobbinsCompleted || 0),
      scrapBobbins: closed.length + carried.scrapBobbins,
      carried,
      totalRunSeconds: Math.round(runSec * 10) / 10,
      totalIdleSeconds: Math.round(idleSec * 10) / 10,
      utilisation: runSec + idleSec > 0 ? Math.round((1000 * runSec) / (runSec + idleSec)) / 10 : null,
      faultStopCount: sum(runs.map(r => r.faultStops)),
      faultStopSeconds: Math.round(sum(runs.map(r => r.faultStopSeconds)) * 10) / 10,
      changeoverSeconds: secs(changeoverIn(startedAt, horizon)),
      missedAlerts: runs.filter(r => r.endedBy === "missed").length,
      abandoned: runs.filter(r => r.endedBy === "abandoned").length,
      medianWarningSeconds: median(warnings),
    },
    bobbins,
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

function bobbinsCSV(bobbins, shift) {
  const cols = ["shift", "shiftName", "completedBobbin", "elapsedSeconds",
                "runSeconds", "idleSeconds", "changeoverSeconds", "scrapBobbins",
                "utilisationPct"];
  const rows = bobbins.map(b => [
    shift ? shift.shiftNo : "", shift ? (shift.name ?? "") : "", b.seq,
    b.elapsedSeconds, b.runSeconds, b.idleSeconds, b.changeoverSeconds,
    b.scrapBobbins, b.utilisation ?? ""]);
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

const Shift = { EV, MISS_ABOVE_PCT, derive, toCSV, bobbinsCSV, createLog, motionIntervals };

if (typeof module !== "undefined" && module.exports) module.exports = Shift;
if (typeof window !== "undefined") window.Shift = Shift;
