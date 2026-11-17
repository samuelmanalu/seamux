'use strict';

// Time per task: every few seconds, look at each task and add the time since
// the last look to the buckets it was in. Plain Node; main.js supplies what
// it sees (terminal states, which terminal you are looking at).

/**
 * Which time buckets a task is in right now.
 * @param {{status:string, paneState?:string|null, looking?:boolean}} o
 */
function bucketsFor({ status, paneState, looking }) {
  const out = [];
  if (paneState === 'running') out.push('agent');
  if (paneState === 'needs_input') out.push('needsYou');
  if (looking) out.push('you');
  if (status === 'waiting') out.push('waiting');
  return out;
}

class TimeTracker {
  /**
   * @param {object} o
   * @param {import('./board').Board} o.board
   * @param {() => Array<{taskId:string, status:string, paneState?:string, looking?:boolean}>} o.observe
   * @param {number} [o.intervalMs]  how often to look
   * @param {number} [o.maxGapMs]    a longer gap (the machine slept) counts as this much
   * @param {number} [o.flushEvery]  write to disk every this many looks
   */
  constructor({ board, observe, intervalMs = 5000, maxGapMs = 30000, flushEvery = 6, now = Date.now }) {
    Object.assign(this, { board, observe, intervalMs, maxGapMs, flushEvery, now });
    this.last = null;
    this.prev = [];
    this.ticks = 0;
    this.timer = null;
  }

  /**
   * Credit the time since the last look to what was seen then, then look
   * again. What a task was doing at the start of a gap is what it gets.
   */
  tick() {
    const t = this.now();
    const gap = this.last === null ? 0 : Math.min(Math.max(0, t - this.last), this.maxGapMs);
    if (gap > 0) {
      for (const o of this.prev) for (const b of bucketsFor(o)) this.board.addTime(o.taskId, b, gap);
    }
    this.last = t;
    this.prev = this.observe();
    this.ticks += 1;
    if (this.ticks % this.flushEvery === 0) this.board.flush();
  }

  start() {
    this.tick();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* next look */ } }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Count up to now and write it down. */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.tick(); } catch { /* quitting */ }
    this.board.flush();
  }
}

module.exports = { TimeTracker, bucketsFor };
