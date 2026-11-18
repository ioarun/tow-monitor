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
  MOTION_STOPPED:         "motion.stopped",        // { pct, outside, by? } by: intervention | reset | end
  DEPLETION_ALERTED:      "depletion.alerted",     // { pct }
  DEPLETION_ACKNOWLEDGED: "depletion.acknowledged",
  STOP_ALERTED:           "stop.alerted",
  STOP_CLEARED:           "stop.cleared",          // { heldFor }
  BOBBIN_COMPLETED:       "bobbin.completed",      // { peakPct }
  CALIBRATION_APPLIED:    "calibration.applied",   // { baseline, ceiling, creamWarm }
  CARRIED_OVER:           "carried.over",          // { bobbinsCompleted, scrapBobbins, idleSeconds }
  INTERVENTION_STARTED:   "intervention.started",  // operator at the machine, door open
  INTERVENTION_ENDED:     "intervention.ended",    // { by: "button" | "reset" | "timeout" | "end" }
  APP_PAUSED:             "app.paused",            // the page went to the background
  APP_RESUMED:            "app.resumed",           // { hiddenFor } seconds it was away
  JOIN_STARTED:           "join.started",          // Reset: the tow is being joined
  JOIN_ENDED:             "join.ended",            // { by: "motion" | "reset" | "end" | "stopped" }
  CAMERA_LOCKED:          "camera.locked",         // { got, asked, unconfirmed } exposure/WB/focus
  /* A raw video was recorded. Nothing derived from the log reads these; they
     are here so a video can be lined up against everything else the shift
     recorded, to the millisecond, by whoever analyses it. */
  VIDEO_STARTED:          "video.started",         // { file, mime, bps, locked, settings }
  VIDEO_STOPPED:          "video.stopped",         // { file, seconds, bytes, by }
  /* Stop detection armed: the figures it will judge the machine by. Nothing
     derived reads it. On 18 Nov bobbin 5 read a still machine as running in 50
     short bursts, and whether its threshold came out too low could not be
     checked -- arming was recorded only in diagnostic traces, and none covered
     it. With this, every bobbin's threshold is in the shift log. */
  MOTION_ARMED:           "motion.armed",          // { attempt, maskSize, level, lateLevel, heldLevel, ratio, stopAt, floor, afterJoin }
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

/* Tube exposure at which a stop after the depletion warning is the operator's
   deliberate end of the bobbin, and the swap begins. The lowest on 18 Nov was
   73.6%; an early stop "in the rush" sits well under it. */
const DELIBERATE_STOP_PCT = 70;

/* Stops the APP caused by not watching, rather than stops the machine made.
 * They are idle either way -- the seconds are real and stay in the figures --
 * but they must never reach faultStops, which is a measure of the MACHINE.
 * A set rather than a string test, because the list keeps growing: the app
 * going to the background (6.7), the page being reloaded (6.14), and a Reset or
 * End pressed while the detector still thought the machine was moving. */
const NOT_THE_MACHINE = new Set(["paused", "reload", "reset", "end"]);

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
      out.push({ start: open, end: e.t, stopPct: typeof e.pct === "number" ? e.pct : null,
                 stopBy: e.by ?? null });
      open = null;
    }
  }
  if (open !== null)
    out.push({ start: open, end: endT, openEnded: true, stopPct: null, stopBy: null });
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
function boundary(closer, intervals, openedAt = -Infinity) {
  const before = intervals.filter(i => i.end <= closer.t);
  let last = before.length ? before[before.length - 1] : null;
  /* The stop a Reset writes when the detector still thought the machine was
     moving says only "the camera was busy until the press" -- usually hands
     during the swap. The swap still starts at the machine's own last stop, if
     this bobbin has one. If it has none, the detector saw this bobbin turning
     right up to the press, and the press is the only end there is: closing it
     anywhere earlier lands before the bobbin began and erases it, which is what
     happened to bobbin 17 on 18 Nov. End's stop is not treated this way: End can
     be pressed with the machine still running, and that stretch is running. */
  if (closer.type === EV.RUN_RESET && last && last.stopBy === "reset") {
    for (let k = before.length - 2; k >= 0; k--)
      if (before[k].stopBy !== "reset" && before[k].end > openedAt) { last = before[k]; break; }
  }
  const closeAt = last ? last.end : closer.t;
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
      if (w.start > i.start) next.push({ ...i, end: w.start, stopPct: null, stopBy: null });
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
  const cuts = closers.map((c, k) => ({ closer: c,
                                        ...boundary(c, raw, k ? closers[k - 1].t : startedAt) }));

  /* The swap starts at your deliberate stop. After the depletion warning the
     operator stops the machine before the tow comes off, and the swap follows;
     the swap used to start at the LAST stop before Reset, so whatever the camera
     took for motion in between -- a gloved hand and the next bobbin's wrap on
     18 Nov, or a still machine's flicker -- was booked as running: 198 s over 13
     bobbins that day, 244 s more on bobbin 5. The deliberate stop is the first
     after the warning at DELIBERATE_STOP_PCT or more; an early stop below it,
     with the machine running on, stays running. */
  cuts.forEach((c, k) => {
    if (c.closer.type !== EV.RUN_RESET) return;
    const from = k ? closers[k - 1].t : startedAt;
    const alert = ev.find(e => e.type === EV.DEPLETION_ALERTED && e.t > from && e.t < c.closer.t);
    if (!alert) return;
    const stop = raw.find(i => i.end > alert.t && i.end < c.closeAt &&
                               typeof i.stopPct === "number" && i.stopPct >= DELIBERATE_STOP_PCT);
    if (stop) c.closeAt = stop.end;
  });

  /* A swap is bounded by a stop and a button press. Whatever moved inside one
     was not the machine making a bobbin, so it is cut out of running time
     everywhere -- per run, per completed bobbin and per shift alike. */
  const swapWindows = cuts.filter(c => c.closer.type === EV.RUN_RESET)
                          .map(c => ({ start: c.closeAt, end: c.closer.t }));

  /* The tow join. Reset means a new scrap bobbin is on; the operator closes the
     door and presses the tow-join button, and for about 100 s the new tow is
     joined to the tail of the old one. The bobbin is NOT still through this --
     the join shifts and the heating element runs along a length of it -- but
     none of that is the machine making a bobbin. How it closed is kept on the
     JOIN_ENDED event.

     So a join is cut out of running time exactly as a swap is, whatever moved
     inside it. Before this, joins were measured and reported but never cut,
     and the page has a way of carrying motion straight into one: Reset sets
     machineMoving false without writing a motion.stopped, so a motion interval
     open at the press -- hands in view during the swap, which is normal, or
     the detector misreading a still bobbin -- ran on through the whole join and
     was booked as the new bobbin's production. It also hid the join itself:
     with motion already present at the run's first instant, the per-run
     joinSeconds below found no lead gap and stayed blank. On 17 Nov the shift
     measured 599.6 s of join and credited 289.5 s of it to bobbins.

     An OPEN window (no JOIN_ENDED) is either a join happening right now, or one
     whose end was lost: the page reloaded mid-join, and nothing on the way back
     writes the JOIN_ENDED -- there is no join equivalent of openPauseAt. Run to
     the horizon, the first is right and the second would now erase every second
     of production for the rest of the shift. So an open window ends at the
     first sign the join is over: the machine confirmed turning, or the next
     Reset or the end of the shift. A join still in progress has none of those
     yet, and runs to now. */
  const joins = [];
  let openJ = null;
  for (const e of ev) {
    if (e.type === EV.JOIN_STARTED && !openJ) openJ = e;
    else if (e.type === EV.JOIN_ENDED && openJ) {
      joins.push({ start: openJ.t, end: e.t, by: e.by ?? null });
      openJ = null;
    }
  }
  if (openJ) {
    const over = ev.find(e => e.t > openJ.t &&
                              (e.type === EV.MOTION_STARTED || CLOSERS.includes(e.type)));
    joins.push({ start: openJ.t, end: over ? Math.min(over.t, horizon) : horizon,
                 by: null, open: true });
  }

  const running = subtract(raw, [...swapWindows, ...joins]);

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

  /* The app in the background: the tablet was taken away for other work, so the
     camera saw nothing. Measured from the event pair rather than inferred from
     the motion log, because a minimize that happened while the machine was
     already stopped records no stop and would otherwise be invisible. A window
     left open is one the shift never came back from. */
  const hidden = [];
  let openH = null;
  for (const e of ev) {
    if (e.type === EV.APP_PAUSED && !openH) openH = e;
    else if (e.type === EV.APP_RESUMED && openH) {
      hidden.push({ start: openH.t, end: e.t });
      openH = null;
    }
  }
  if (openH) hidden.push({ start: openH.t, end: horizon, open: true });
  const hiddenIn = (from, to) => within(hidden, from, to);

  // `joins` itself is built above `running`, which it is cut out of
  const joinIn = (from, to) => within(joins, from, to);

  const idle = [];            // every stopped period counted as idle during a build
  const runs = [];
  let openAt = (ev.find(e => e.type === EV.RUN_STARTED) || { t: startedAt }).t;

  const build = (from, to, cut) => {
    const closer = cut ? cut.closer : null;
    const mine = ev.filter(e => e.t >= from && e.t <= to);
    const spans = running.map(i => {
      const o = overlap(i, from, to);
      return o ? { ...o, stopPct: o.end === i.end ? i.stopPct : null,
                         stopBy: o.end === i.end ? i.stopBy : null } : null;
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

    /* THE TOW JOIN. Reset means a new scrap bobbin is on, and the new tow then
       has to be joined to the tail of the old one -- about a minute, machine
       deliberately still, after which it starts turning by itself. That minute
       was being thrown away: idle below is built from the gaps BETWEEN motion
       spans, and this one sits before the first span, with nothing in front of
       it to close. Measured on a 410 s fixture with one join, 72 s went
       unaccounted for and utilisation read 94.1% where the truth was 79.5%.

       Only a gap a join window explains is claimed. The same gap after Start
       means something else entirely: the detector needs MOTION_WARMUP to learn
       its mask before it can report motion at all, so the first motion.started
       of a shift arrives about 13 s after the press however long the machine
       has been turning. Those seconds are unobserved, not idle, and booking
       them as idle would charge the operator for the warm-up. A join window is
       the one case where the stillness is known rather than inferred -- the
       operator pressed Reset and is standing there joining the tow.

       Runs with no motion at all are also left alone. Their nominal range is
       degenerate (`boundary` takes closeAt from the last motion ANYWHERE before
       the closer, which lands before such a run even opened, so `to` precedes
       `from`) and they already mis-add: two Resets with nothing moving between
       them overlap their swap windows and double-count the gap, 8 s on a 210 s
       fixture. Claiming the lead gap on top of that made it worse, not better
       (-8 s to -20 s). That is a separate known fault, left as it was. Such a
       join is still reported through towJoinSeconds, which is measured from the
       event pair and does not depend on this arithmetic. */
    const joinStarted = mine.find(e => e.type === EV.JOIN_STARTED);
    let joinSeconds = null;
    const firstMotion = spans.length ? spans[0].start : null;
    if (joinStarted && firstMotion !== null && firstMotion > from) {
      const w = { start: from, end: firstMotion };
      const seconds = secs(net(w.start, w.end));
      if (seconds > 0) {
        stops.push({ ...w, kind: "join", seconds, exposurePct: null });
        idle.push({ ...w, kind: "join" });
        joinSeconds = seconds;
      }
    }

    for (let i = 0; i < spans.length - 1; i++) {
      const g = { start: spans[i].end, end: spans[i + 1].start };
      /* A stop recorded because the app went to the background is not the
         machine failing -- the tablet was being used for something else. This
         is the away-stop fix of 8332fc6 applied to the one case that survived
         it: a figure meant to measure the machine must not count a stop the
         operator caused by taking the tablet away. The seconds are still idle;
         only the blame changes. */
      const kind = NOT_THE_MACHINE.has(spans[i].stopBy) ? "paused"
                 : alert && g.start >= alert.t ? "pause" : "fault";
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
      pausedStops: of("paused").length,
      pausedStopSeconds: total(of("paused")),
      joinSeconds,
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
      // the two kinds added up: everything this bobbin stood still for,
      // whichever side of the previous completion it fell
      totalIdleSeconds: secs(idleMs + afterIn(from, to)),
      attendedSeconds: secs(attendedIn(from, to)),
      appPausedSeconds: secs(hiddenIn(from, to)),
      towJoinSeconds: secs(joinIn(from, to)),
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
    // and into its total, which is the figure the operator compares against
    bobbins[0].totalIdleSeconds =
      Math.round((bobbins[0].totalIdleSeconds + carried.idleSeconds) * 10) / 10;
    const r = bobbins[0].runSeconds, i = bobbins[0].idleDuringBobbinBuildSeconds;
    bobbins[0].utilisation = r + i > 0 ? Math.round((1000 * r) / (r + i)) / 10 : null;
  }

  /* Idle on the bobbin being built, rather than on the whole shift. Without
     it the only figure on screen is the shift total, which can only ever climb
     -- so an hour lost at 16:00 is still sitting in the number at 22:00, and
     the operator cannot see whether the bobbin in front of them is going well.

     It has three states, because between one bobbin and the next there is no
     bobbin being built:

       before any completion   counting from the start of the shift, carry
                               included -- the carry was spent on this bobbin
       completed, no Reset yet FROZEN at what that bobbin cost. The operator
                               is changing it over and this is the last
                               complete answer there is; a counter that reset
                               itself the moment they pressed the button would
                               blank the number they pressed it to read
       Reset pressed           counting again from that press, at zero

     The FIRST Reset after the completion is what starts the next bobbin.
     Later Resets are scrap-bobbin swaps, several per bobbin, and must not
     restart the count.

     The changeover itself -- completion to that first Reset -- is on neither
     bobbin: it is idleAfterBobbinCompleteSeconds, which is counted and
     exported separately, and it is in the shift total either way. */
  const lastCompletion = completions.length ? completions[completions.length - 1] : null;
  const startsNext = lastCompletion
    ? ev.find(e => e.type === EV.RUN_RESET && e.t >= lastCompletion.t) : null;
  const currentBobbinFrozen = !!lastCompletion && !startsNext;
  const idleSince = from => Math.round(10 * secs(idleIn(from, horizon) + afterIn(from, horizon))) / 10;
  const currentBobbinIdleSeconds =
      !lastCompletion ? Math.round(10 * (secs(idleIn(startedAt, horizon) + afterIn(startedAt, horizon))
                                         + carried.idleSeconds)) / 10
    : currentBobbinFrozen ? bobbins[bobbins.length - 1].totalIdleSeconds
    : idleSince(startsNext.t);

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
      /* The two figures the operator reads: this bobbin, and the shift. They
         compose -- every completed bobbin's totalIdleSeconds plus this one
         adds up to totalIdleSeconds above. */
      currentBobbinIdleSeconds,
      // true while it is showing the bobbin that just came off, not one being
      // built -- the screen says "last bobbin" rather than "this bobbin"
      currentBobbinFrozen,
      lastBobbinIdleSeconds: bobbins.length ? bobbins[bobbins.length - 1].totalIdleSeconds : null,
      attendedSeconds: secs(attendedIn(startedAt, horizon)),
      appPausedSeconds: secs(hiddenIn(startedAt, horizon)),
      appPauses: hidden.length,
      /* What joining the tow cost across the shift, and how many of those joins
         the machine never started itself after. Only "motion" means the mask
         formed, which is the one proof available that the bobbin turned; a join
         closed by the next Reset, by the shift ending or by the camera going
         away is one the operator had to deal with, and is what they were
         alarmed about. An open window counts the same way -- it never came
         good either. */
      towJoinSeconds: secs(joinIn(startedAt, horizon)),
      towJoins: joins.length,
      towJoinsWithoutMotion: joins.filter(w => w.by !== "motion").length,
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
                "depletionPauses", "depletionPauseSeconds",
                "pausedStops", "pausedStopSeconds", "joinSeconds", "stopsAt"];
  // "fault 12.0 / pause 40.1 / swap 99.2" -- no commas, so it survives as one cell
  const stopsAt = r => (r.stops || [])
    .filter(x => x.kind !== "current" && x.kind !== "join" && x.kind !== "startup")
    .map(x => `${x.kind} ${x.exposurePct ?? "?"}`).join(" / ");
  const rows = runs.map(r => [
    shift ? shift.shiftNo : "", shift ? (shift.name ?? "") : "",
    r.seq, r.runSeconds, r.swapSeconds ?? "",
    r.peakPct ?? "", r.warningSeconds ?? "", r.ackSeconds ?? "", r.endedBy,
    r.faultStops, r.faultStopSeconds, r.depletionPauses, r.depletionPauseSeconds,
    r.pausedStops, r.pausedStopSeconds, r.joinSeconds ?? "", stopsAt(r)]);
  return [cols.join(","), ...rows.map(r => r.join(","))].join("\n");
}

function bobbinsCSV(bobbins, shift) {
  const cols = ["shift", "shiftName", "completedBobbin", "elapsedSeconds", "runSeconds",
                "idleDuringBobbinBuildSeconds", "idleAfterBobbinCompleteSeconds",
                "totalIdleSeconds", "attendedSeconds", "appPausedSeconds", "towJoinSeconds",
                "scrapBobbins", "utilisationPct"];
  const rows = bobbins.map(b => [
    shift ? shift.shiftNo : "", shift ? (shift.name ?? "") : "", b.seq,
    b.elapsedSeconds, b.runSeconds, b.idleDuringBobbinBuildSeconds,
    b.idleAfterBobbinCompleteSeconds, b.totalIdleSeconds, b.attendedSeconds,
    b.appPausedSeconds, b.towJoinSeconds, b.scrapBobbins, b.utilisation ?? ""]);
  return [cols.join(","), ...rows.map(r => r.join(","))].join("\n");
}

/* The shift on one line: what End is for.
 *
 * bobbinsCSV answers "how did each completed bobbin go", which is a different
 * question and a different number of rows -- none at all on a shift that ended
 * before anything was finished, which is exactly the shift someone wants a
 * summary of. The three figures asked for are first: scrap bobbins used, run
 * time, idle time. The rest is there so the row can be read six weeks later
 * without the JSON beside it.
 *
 * elapsedSeconds is run plus total idle: the wall clock this shift accounts
 * for. utilisationPct is NOT run/elapsed -- it leaves out the time between one
 * bobbin finishing and the next starting, because a shift should not look worse
 * the more bobbins it completes. Both columns are here so the difference is
 * visible rather than argued about. */
function shiftCSV(shifts) {
  const cols = ["shift", "shiftName", "startedAt", "endedAt", "elapsedSeconds",
                "scrapBobbins", "totalRunSeconds", "totalIdleSeconds", "utilisationPct",
                "bobbinsCompleted", "idleDuringBobbinBuildSeconds",
                "idleAfterBobbinCompleteSeconds", "swapSeconds",
                "towJoinSeconds", "towJoins", "towJoinsWithoutMotion",
                "attendedSeconds", "interventions", "appPausedSeconds", "appPauses",
                "faultStopCount", "faultStopSeconds",
                "depletionPauseCount", "depletionPauseSeconds",
                "missedAlerts", "abandoned", "medianWarningSeconds"];
  const iso = t => (t ? new Date(t).toISOString() : "");
  const r1 = x => Math.round(x * 10) / 10;
  const rows = shifts.filter(Boolean).map(s => [
    s.shiftNo ?? "", s.name ?? "", iso(s.startedAt), iso(s.endedAt),
    r1((s.totalRunSeconds || 0) + (s.totalIdleSeconds || 0)),
    s.scrapBobbins, s.totalRunSeconds, s.totalIdleSeconds, s.utilisation ?? "",
    s.bobbinsCompleted, s.idleDuringBobbinBuildSeconds,
    s.idleAfterBobbinCompleteSeconds, s.swapSeconds,
    s.towJoinSeconds, s.towJoins, s.towJoinsWithoutMotion,
    s.attendedSeconds, s.interventions, s.appPausedSeconds, s.appPauses,
    s.faultStopCount, s.faultStopSeconds,
    s.depletionPauseCount, s.depletionPauseSeconds,
    s.missedAlerts, s.abandoned, s.medianWarningSeconds ?? ""]);
  return [cols.join(","), ...rows.map(r => r.join(","))].join("\n");
}

/* An export, as names and contents. The page only has to hand each one to the
 * browser, which is the part that cannot be tested outside one -- everything
 * about which files appear, what they are called and what is in them is here.
 *
 * Both exports come through this: the button, which takes the whole kept
 * history, and the end of a shift, which takes only the shift that just ended.
 * One shift per set of files keeps a day's export clean; the alternative, each
 * export carrying every shift again, is a pile of files that mostly repeat.
 *
 * The per-bobbin file is omitted when no bobbin was finished, rather than being
 * written with a header and no rows -- an empty file in Downloads reads as a
 * failed export. */
function exportFiles(bundle, stamp, { now = null } = {}) {
  const t = now ?? Date.now();
  const derived = bundle.map(b => derive(b.events, { now: t }));
  const rows  = derived.flatMap(d => toCSV(d.runs, d.shift).split("\n").slice(1));
  const bRows = derived.flatMap(d => bobbinsCSV(d.bobbins, d.shift).split("\n").slice(1));
  const files = [{
    name: `tow-scrap-bobbins-${stamp}.csv`, type: "text/csv",
    text: [toCSV([], null).split("\n")[0], ...rows].join("\n"),
  }];
  if (bRows.length) files.push({
    name: `tow-bobbins-${stamp}.csv`, type: "text/csv",
    text: [bobbinsCSV([], null).split("\n")[0], ...bRows].join("\n"),
  });
  /* Unconditional, unlike the bobbins file. A shift that finished no bobbins
     still used scrap bobbins and still stood idle, and that is the shift whose
     summary is hardest to reconstruct afterwards. */
  files.push({
    name: `tow-shift-summary-${stamp}.csv`, type: "text/csv",
    text: shiftCSV(derived.map(d => d.shift)),
  });
  files.push({
    name: `tow-shifts-${stamp}.json`, type: "application/json",
    text: JSON.stringify(bundle, null, 1),
  });
  return files;
}

/* A shift is named by the operator, so it reaches a filename through this.
 * Anything that is not a letter or digit becomes a hyphen, which leaves a name
 * safe on every filesystem the files might land on. */
function fileSlug(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
                     .replace(/^-+|-+$/g, "").slice(0, 24) || "shift";
}

/* A log that records and nothing else. Keeping it this thin is the point: the
 * app appends, the derivation reads, and neither knows about the other. */
/* `initial` restores a shift that was interrupted; `onAdd` fires after every
 * event so the caller can persist the log without having to remember to. The
 * hook rather than scattered save calls is deliberate: §10 deferred surviving a
 * reload on the grounds that it would cost a session only occasionally, and the
 * background pause of §6.7 made that wrong -- a long minimize is exactly when
 * Android discards the page. One missed save site would reopen the hole, so
 * there is only one site. A shift runs to a few hundred events, so saving on
 * each one is a few hundred small writes across a working day. */
function createLog(shiftNo, { initial = [], onAdd = null } = {}) {
  const events = [...initial];
  return {
    events,
    add(type, payload = {}, t = Date.now()) {
      const e = { t, type, ...payload };
      events.push(e);
      if (onAdd) onAdd(e, events);
      return e;
    },
    derive(opts) { return derive(events, opts); },
    get shiftNo() { return shiftNo; },
  };
}

/* When a pause was never resumed, its timestamp; otherwise null.
 *
 * The page can be DISCARDED while hidden, which takes the in-memory hiddenSince
 * with it, so nothing is left to record the return. An unclosed pause runs to
 * the horizon (see the hidden windows in derive), which would charge every hour
 * of the rest of the shift to time the app was away. Whoever restores the log
 * closes it at the moment the operator came back, which is the one thing we do
 * know: they are here, pressing Start. */
function openPauseAt(events) {
  let at = null;
  for (const e of events) {
    if (e.type === EV.APP_PAUSED) at = e.t;
    else if (e.type === EV.APP_RESUMED) at = null;
  }
  return at;
}

const Shift = { EV, MISS_ABOVE_PCT, derive, toCSV, bobbinsCSV, shiftCSV, createLog, motionIntervals,
                openPauseAt, exportFiles, fileSlug };

if (typeof module !== "undefined" && module.exports) module.exports = Shift;
if (typeof window !== "undefined") window.Shift = Shift;
