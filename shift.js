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
  MOTION_STARTED:         "motion.started",        // { level, outside }
  MOTION_STOPPED:         "motion.stopped",        // { pct, outside }
  DEPLETION_ALERTED:      "depletion.alerted",     // { pct }
  DEPLETION_ACKNOWLEDGED: "depletion.acknowledged",
  STOP_ALERTED:           "stop.alerted",
  STOP_CLEARED:           "stop.cleared",          // { heldFor }
  BOBBIN_COMPLETED:       "bobbin.completed",      // { peakPct }
  CALIBRATION_APPLIED:    "calibration.applied",   // { baseline, ceiling, creamWarm }
  CARRIED_OVER:           "carried.over",          // { bobbinsCompleted, scrapBobbins, idleSeconds }
  INTERVENTION_STARTED:   "intervention.started",  // operator at the machine, door open
  INTERVENTION_ENDED:     "intervention.ended",    // { by: "button" | "reset" | "timeout" | "end" }
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
 * run, rather than per run, so a run boundary can be snapped onto them. Each
 * keeps the exposure reading from the moment it stopped -- the only thing that
 * tells an early stop at 40% apart from the real one at 99%. */
function motionIntervals(events, endT) {
  const out = [];
  let open = null;
  for (const e of events) {
    if (e.type === EV.MOTION_STARTED && open === null) open = e.t;
    else if (e.type === EV.MOTION_STOPPED && open !== null) {
      out.push({ start: open, end: e.t, stopPct: typeof e.pct === "number" ? e.pct : null });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: endT, openEnded: true, stopPct: null });
  return out;
}

/* Where one scrap bobbin ends and the next begins.
 *
 * Reset is the operator saying a swap happened, which is true however the last
 * bobbin ended -- depleted, abandoned mid-fault, tow broken. The bobbin closes
 * at the last stop before Reset, and the next one opens AT Reset. Everything
 * between is the swap.
 *
 * Opening at Reset was the operator's call on 15 Oct. The earlier rule opened
 * the next run when motion resumed, which credited the seconds between
 * restarting the machine and reaching the tablet as running. Opening at Reset
 * counts those seconds as swap instead, and buys something worth more: nothing
 * the camera sees during a swap -- hands, the door, re-threading -- can change
 * how long the swap took, because the swap is bounded by the stop and a button.
 *
 * A Reset with no stop before it is a mis-press; both edges fall on the press,
 * which keeps runs in order and loses nothing. */
function boundary(closer, intervals) {
  const before = intervals.filter(i => i.end <= closer.t);
  const closeAt = before.length ? before[before.length - 1].end : closer.t;
  return { closeAt, openAt: closer.t };
}

function overlap(interval, from, to) {
  const a = Math.max(interval.start, from), b = Math.min(interval.end, to);
  return b > a ? { start: a, end: b } : null;
}

const lengthOf = xs => sum(xs.map(x => x.end - x.start));

/* Intervals with windows cut out of them. */
function subtract(intervals, windows) {
  let out = intervals.map(i => ({ ...i }));
  for (const w of windows) {
    const next = [];
    for (const i of out) {
      if (w.end <= i.start || w.start >= i.end) { next.push(i); continue; }
      if (w.start > i.start) next.push({ ...i, end: w.start, stopPct: null });
      if (w.end < i.end) next.push({ ...i, start: w.end });
    }
    out = next;
  }
  return out;
}

/* events -> { shift, bobbins, runs }. Pure: no clock, no storage, no DOM.
 * `now` is only used to close a shift that is still open. */
function derive(events, { now = null, missAbovePct = MISS_ABOVE_PCT } = {}) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  if (!ev.length) return { shift: null, bobbins: [], runs: [] };

  const started = ev.find(e => e.type === EV.SHIFT_STARTED);
  const ended = ev.find(e => e.type === EV.SHIFT_ENDED);
  const startedAt = started ? started.t : ev[0].t;
  const endedAt = ended ? ended.t : null;
  const horizon = endedAt ?? now ?? ev[ev.length - 1].t;

  const raw = motionIntervals(ev, horizon);
  const closers = ev.filter(e => CLOSERS.includes(e.type));
  const cuts = closers.map(c => ({ closer: c, ...boundary(c, raw) }));

  /* A swap is bounded by a stop and a button press. Whatever moved inside one
     was not the machine making a bobbin, so it is cut out of running time
     everywhere -- per run, per completed bobbin and per shift alike. */
  const swapWindows = cuts.filter(c => c.closer.type === EV.RUN_RESET)
                          .map(c => ({ start: c.closeAt, end: c.closer.t }));
  const running = subtract(raw, swapWindows);

  /* Time after a bobbin is completed, when no bobbin is being made: from the
     completion until the machine turns again on the next. Changing the bobbin
     over is part of it, and so is a forty-minute break before anyone comes
     back to start another. It is not idle-during-build, which means the
     machine stopped while a bobbin was being made; lumping them together made
     a shift look worse the more bobbins it finished.

     It only exists if the machine was ALREADY STOPPED when the bobbin was
     called complete. An earlier version ran the window to the next Reset,
     which on a completion pressed mid-run swallowed every fault stop in
     between and zeroed the shift's idle time. If the machine is still turning,
     nothing is being changed over yet. */
  const rawGaps = [];
  for (let i = 0; i < raw.length - 1; i++) rawGaps.push({ start: raw[i].end, end: raw[i + 1].start });
  const lastRaw = raw[raw.length - 1];
  if (lastRaw && !lastRaw.openEnded && lastRaw.end < horizon)
    rawGaps.push({ start: lastRaw.end, end: horizon });     // stopped right up to now

  const afterComplete = [];
  for (const c of ev.filter(e => e.type === EV.BOBBIN_COMPLETED)) {
    const during = rawGaps.find(g => c.t >= g.start && c.t < g.end);
    if (during) afterComplete.push({ start: c.t, end: during.end });
  }
  const within = (windows, from, to) =>
    sum(windows.map(w => { const o = overlap(w, from, to); return o ? o.end - o.start : 0; }));
  const afterIn = (from, to) => within(afterComplete, from, to);
  // a stopped stretch, with any after-completion time taken out of it
  const net = (from, to) => Math.max(0, (to - from) - afterIn(from, to));

  /* Operator intervention: the door is open and someone is at the machine.
     Each window keeps how it ended, so ones that ran out on the timeout --
     where the operator may well have walked away first -- can be told apart
     from ones they closed themselves. */
  const attended = [];
  let openI = null;
  for (const e of ev) {
    if (e.type === EV.INTERVENTION_STARTED && !openI) openI = e;
    else if (e.type === EV.INTERVENTION_ENDED && openI) {
      attended.push({ start: openI.t, end: e.t, by: e.by ?? null });
      openI = null;
    }
  }
  if (openI) attended.push({ start: openI.t, end: horizon, by: null, open: true });
  const attendedIn = (from, to) => within(attended, from, to);

  const idle = [];            // every stopped period counted as idle during a build
  const runs = [];
  let openAt = (ev.find(e => e.type === EV.RUN_STARTED) || { t: startedAt }).t;

  const build = (from, to, cut) => {
    const closer = cut ? cut.closer : null;
    const mine = ev.filter(e => e.t >= from && e.t <= to);
    const spans = running.map(i => {
      const o = overlap(i, from, to);
      return o ? { ...o, stopPct: o.end === i.end ? i.stopPct : null } : null;
    }).filter(Boolean);
    const alert = mine.find(e => e.type === EV.DEPLETION_ALERTED);
    const ack = mine.find(e => e.type === EV.DEPLETION_ACKNOWLEDGED);
    const lastStop = spans.length ? spans[spans.length - 1].end : null;
    const stoppedAtEnd = spans.length > 0 && (!!closer || lastStop < to);
    const peakPct = closer && typeof closer.peakPct === "number" ? closer.peakPct
                  : alert ? alert.pct : null;

    /* Every stop inside a run is the machine halting and restarting on the same
       scrap bobbin. Before the depletion alert that is a tow-width fault. After
       it, it is the operator stopping early -- stopped at 40% in the rush, then
       carried on to 99% -- which is a pause, not a fault, and is counted apart
       so the fault figure stays a measure of the machine. */
    const stops = [];
    for (let i = 0; i < spans.length - 1; i++) {
      const g = { start: spans[i].end, end: spans[i + 1].start };
      const kind = alert && g.start >= alert.t ? "pause" : "fault";
      stops.push({ ...g, kind, seconds: secs(net(g.start, g.end)), exposurePct: spans[i].stopPct });
      idle.push({ ...g, kind });
    }
    let swapSeconds = null;
    if (closer && closer.type === EV.RUN_RESET) {
      const w = { start: cut.closeAt, end: closer.t };
      swapSeconds = secs(net(w.start, w.end));
      stops.push({ ...w, kind: "swap", seconds: swapSeconds,
                   exposurePct: spans.length ? spans[spans.length - 1].stopPct : null });
      idle.push({ ...w, kind: "swap" });
    } else if (!closer && spans.length && lastStop < to) {
      // stopped right now, on a bobbin still in progress: counted live, and
      // recomputed exactly once Reset says what kind of stop it was
      const w = { start: lastStop, end: to };
      stops.push({ ...w, kind: "current", seconds: secs(net(w.start, w.end)),
                   exposurePct: spans[spans.length - 1].stopPct });
      idle.push({ ...w, kind: "current" });
    }
    const of = kind => stops.filter(x => x.kind === kind);
    const total = xs => secs(sum(xs.map(x => net(x.start, x.end))));

    return {
      seq: runs.length + 1,
      startedAt: from,
      endedAt: to,
      runSeconds: secs(lengthOf(spans)),
      peakPct,
      alertedAt: alert ? alert.t : null,
      alertPct: alert ? alert.pct : null,
      // to the LAST stop: an early stop at 40% is not the tow running out, and
      // measuring to it would flatter the system
      warningSeconds: alert && stoppedAtEnd ? secs(lastStop - alert.t) : null,
      ackSeconds: alert && ack ? secs(ack.t - alert.t) : null,
      endedBy: alert ? "depleted"
             : (peakPct !== null && peakPct >= missAbovePct) ? "missed" : "abandoned",
      faultStops: of("fault").length,
      faultStopSeconds: total(of("fault")),
      depletionPauses: of("pause").length,
      depletionPauseSeconds: total(of("pause")),
      swapSeconds,
      stops,
      open: !closer,
    };
  };

  for (const cut of cuts) {
    runs.push(build(openAt, cut.closeAt, cut));
    openAt = cut.openAt;
  }
  // a run in progress: everything after the last boundary
  if (!endedAt && openAt < horizon) runs.push(build(openAt, horizon, null));

  const idleIn = (from, to) =>
    sum(idle.map(p => { const o = overlap(p, from, to); return o ? net(o.start, o.end) : 0; }));

  /* Per completed bobbin. A shift finishes as many as it finishes, and the
     operator wants to know what each one cost -- so the shift is cut at every
     completion and what happened inside each piece is measured. Cut on the
     timeline rather than on whole runs, because a bobbin usually completes
     part-way through a scrap bobbin whose time belongs to both sides. */
  const completions = ev.filter(e => e.type === EV.BOBBIN_COMPLETED);
  const bobbins = completions.map((c, i) => {
    const from = i ? completions[i - 1].t : startedAt;
    const to = c.t;
    const run = lengthOf(running.map(x => overlap(x, from, to)).filter(Boolean));
    const idleMs = idleIn(from, to);
    return {
      seq: i + 1,
      startedAt: from, endedAt: to,
      elapsedSeconds: secs(to - from),
      runSeconds: secs(run),
      idleDuringBobbinBuildSeconds: secs(idleMs),
      idleAfterBobbinCompleteSeconds: secs(afterIn(from, to)),
      attendedSeconds: secs(attendedIn(from, to)),
      // a scrap bobbin counts against whichever bobbin it was used up feeding
      scrapBobbins: runs.filter(r => !r.open && r.endedAt > from && r.endedAt <= to).length,
      utilisation: run + idleMs > 0 ? Math.round((1000 * run) / (run + idleMs)) / 10 : null,
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
    bobbins[0].idleDuringBobbinBuildSeconds =
      Math.round((bobbins[0].idleDuringBobbinBuildSeconds + carried.idleSeconds) * 10) / 10;
    const r = bobbins[0].runSeconds, i = bobbins[0].idleDuringBobbinBuildSeconds;
    bobbins[0].utilisation = r + i > 0 ? Math.round((1000 * r) / (r + i)) / 10 : null;
  }

  const closed = runs.filter(r => !r.open);
  const warnings = runs.map(r => r.warningSeconds).filter(x => x !== null);
  const runSec = sum(runs.map(r => r.runSeconds));
  const idleSec = secs(sum(idle.map(p => net(p.start, p.end)))) + carried.idleSeconds;
  const r1 = x => Math.round(x * 10) / 10;

  return {
    shift: {
      shiftNo: started ? started.shiftNo : null,
      name: started ? (started.name ?? null) : null,
      startedAt, endedAt,
      bobbinsCompleted: completions.length + carried.bobbinsCompleted,
      scrapBobbins: closed.length + carried.scrapBobbins,
      carried,
      totalRunSeconds: r1(runSec),
      idleDuringBobbinBuildSeconds: r1(idleSec),
      utilisation: runSec + idleSec > 0 ? Math.round((1000 * runSec) / (runSec + idleSec)) / 10 : null,
      faultStopCount: sum(runs.map(r => r.faultStops)),
      faultStopSeconds: r1(sum(runs.map(r => r.faultStopSeconds))),
      depletionPauseCount: sum(runs.map(r => r.depletionPauses)),
      depletionPauseSeconds: r1(sum(runs.map(r => r.depletionPauseSeconds))),
      swapSeconds: r1(sum(runs.map(r => r.swapSeconds || 0))),
      idleAfterBobbinCompleteSeconds: secs(afterIn(startedAt, horizon)),
      /* Every second the machine stood still: stopped during a build, plus
         stopped between one bobbin and the next. The figure on screen. */
      totalIdleSeconds: r1(idleSec + secs(afterIn(startedAt, horizon))),
      attendedSeconds: secs(attendedIn(startedAt, horizon)),
      interventions: attended.length,
      interventionsTimedOut: attended.filter(w => w.by === "timeout").length,
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
  const cols = ["shift", "shiftName", "bobbin", "runSeconds", "swapSeconds", "peakPct",
                "warningSeconds", "ackSeconds", "endedBy", "faultStops", "faultStopSeconds",
                "depletionPauses", "depletionPauseSeconds", "stopsAt"];
  // "fault 12.0 / pause 40.1 / swap 99.2" -- no commas, so it survives as one cell
  const stopsAt = r => (r.stops || []).filter(x => x.kind !== "current")
    .map(x => `${x.kind} ${x.exposurePct ?? "?"}`).join(" / ");
  const rows = runs.map(r => [
    shift ? shift.shiftNo : "", shift ? (shift.name ?? "") : "",
    r.seq, r.runSeconds, r.swapSeconds ?? "",
    r.peakPct ?? "", r.warningSeconds ?? "", r.ackSeconds ?? "", r.endedBy,
    r.faultStops, r.faultStopSeconds, r.depletionPauses, r.depletionPauseSeconds, stopsAt(r)]);
  return [cols.join(","), ...rows.map(r => r.join(","))].join("\n");
}

function bobbinsCSV(bobbins, shift) {
  const cols = ["shift", "shiftName", "completedBobbin", "elapsedSeconds", "runSeconds",
                "idleDuringBobbinBuildSeconds", "idleAfterBobbinCompleteSeconds",
                "attendedSeconds", "scrapBobbins", "utilisationPct"];
  const rows = bobbins.map(b => [
    shift ? shift.shiftNo : "", shift ? (shift.name ?? "") : "", b.seq,
    b.elapsedSeconds, b.runSeconds, b.idleDuringBobbinBuildSeconds,
    b.idleAfterBobbinCompleteSeconds, b.attendedSeconds, b.scrapBobbins, b.utilisation ?? ""]);
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
