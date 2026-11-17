'use strict';

/* global H, panes, activate */

// Focus mode: one task's terminal gets the window for a set time. The
// sidebar and board step aside, other tasks that need you are counted but
// not announced, and switching away asks you to end focus first.
(function () {
  const barEl = document.querySelector('#focusbar');
  const LENGTHS = [25, 50, 90];
  let cur = null;
  let tick = null;

  const toast = (text, bad) => window.__knowledge && window.__knowledge.toast(text, bad);
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

  function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  }

  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function minutesText(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? 'under a minute' : `${m} min`;
  }

  function lastLength() {
    try { const v = Number(localStorage.getItem('focusMinutes')); return v >= 1 && v <= 240 ? v : 25; } catch { return 25; }
  }

  function render() {
    document.body.classList.toggle('focus-mode', !!cur);
    barEl.hidden = !cur;
    if (!cur) { barEl.replaceChildren(); return; }
    const held = cur.held.length;
    barEl.replaceChildren(
      h('span', { class: 'f-label', text: 'Focus' }),
      h('strong', { class: 'f-title', text: cur.title }),
      h('span', { class: 'f-clock', id: 'focus-clock', text: clock(cur.endsAt - Date.now()) }),
      h('span', { class: 'spacer' }),
      held ? h('span', { class: 'f-held', title: 'Held until focus ends', text: `${held} other${held === 1 ? '' : 's'} need${held === 1 ? 's' : ''} you` }) : null,
      h('button', { class: 'mini', text: '+5 min', onclick: () => extend(5) }),
      h('button', { class: 'mini', text: 'End focus', title: 'End focus (⌘⇧F)', onclick: end }));
  }

  function set(focus) {
    const was = cur;
    cur = focus;
    clearInterval(tick);
    if (cur) {
      tick = setInterval(() => { const n = document.querySelector('#focus-clock'); if (n && cur) n.textContent = clock(cur.endsAt - Date.now()); }, 1000);
      if (!was || was.paneId !== cur.paneId) {
        if (window.__board && window.__board.visible) window.__board.hide();
        activate(cur.paneId);
      }
    }
    render();
    if (window.__board) window.__board.renderDrawer();
    // The sidebar came or went: terminals take the new width.
    requestAnimationFrame(() => { for (const p of panes.values()) if (p.el.classList.contains('active')) p.fit.fit(); });
  }

  /** Is switching to this terminal allowed? Says why not when it is not. */
  function allows(paneId) {
    if (!cur || paneId === cur.paneId) return true;
    blocked();
    return false;
  }

  function blocked() {
    const held = cur ? cur.held.length : 0;
    toast(`Focusing on “${cur.title}”.${held ? ` ${held} other${held === 1 ? '' : 's'} need${held === 1 ? 's' : ''} you.` : ''} End focus (⌘⇧F) to switch.`);
  }

  async function begin(taskId, minutes) {
    const B = window.__board;
    const t = B.taskOf(taskId);
    if (!t) return;
    if (!t.pane || t.pane.exited) {
      const r = await H.boardStart(taskId);
      if (r && r.status === 'queued') throw new Error(`it is queued (${r.reason}), so it has no terminal yet`);
      if (r && r.pane && !panes.has(r.pane.id)) window.addPane(r.pane);
    }
    set(await H.focusStart(taskId, minutes));
    try { localStorage.setItem('focusMinutes', String(minutes)); } catch { /* not remembered */ }
  }

  /** Pick a length and start focus on a task. */
  function dialog(taskId) {
    const B = window.__board;
    const t = taskId && B.taskOf(taskId);
    if (!t) { toast('Pick a task to focus on: select a card, or open a task’s terminal.'); return; }
    if (t.blockedBy && t.blockedBy.length && !(t.pane && !t.pane.exited)) { toast(`“${t.title}” waits for ${t.blockedBy.map((b) => b.title).join(', ')}.`, true); return; }
    const UI = window.__envUI;
    let minutes = lastLength();
    const custom = h('input', { class: 'field', id: 'focus-minutes', inputmode: 'numeric', value: String(minutes) });
    const choices = h('div', { class: 'f-choices' }, ...LENGTHS.map((m) => h('button', {
      class: 'mini' + (m === minutes ? ' on' : ''),
      text: `${m} min`,
      onclick: () => { custom.value = String(m); for (const b of choices.children) b.classList.toggle('on', b.textContent === `${m} min`); },
    })));
    const err = h('p', { class: 'b-err', id: 'focus-error', hidden: '' });
    const go = async () => {
      minutes = custom.value;
      try { await begin(t.id, minutes); m.close(); } catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
    custom.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    const live = t.pane && !t.pane.exited;
    const m = UI.openModal({
      title: `Focus on “${t.title}”`,
      subtitle: live ? 'Its terminal gets the window. Other tasks that need you wait until focus ends.'
        : 'Starts its terminal, then gives it the window. Other tasks that need you wait until focus ends.',
      body: h('div', { class: 'f-body' }, choices, h('label', { class: 'dim small', text: 'Minutes' }), custom, err),
      footer: h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }),
        h('button', { class: 'btn primary', text: 'Start focus', onclick: go })),
    });
    requestAnimationFrame(() => custom.select());
  }

  async function extend(minutes) {
    try { set(await H.focusExtend(minutes)); } catch (e) { toast(errText(e), true); }
  }

  async function end() { await H.focusStop(); }

  /** ⌘⇧F: end focus, or start it on the task in front of you. */
  function menu() {
    if (cur) { end(); return; }
    const B = window.__board;
    const t = B.visible ? B.selectedTask() : B.currentTask();
    dialog(t && t.id);
  }

  H.onFocusChanged(({ focus, summary }) => {
    set(focus);
    if (!summary) return;
    const n = summary.held.length;
    const others = n ? ` ${n} other task${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you (⌘J).` : '';
    const lead = {
      done: `Focus done: ${minutesText(summary.spentMs)} on “${summary.title}”.`,
      terminal: `Focus ended: the terminal of “${summary.title}” closed.`,
      removed: `Focus ended: “${summary.title}” was deleted.`,
    }[summary.why] || `Focus ended after ${minutesText(summary.spentMs)} on “${summary.title}”.`;
    toast(lead + others);
  });
  H.onFocusMenu(menu);
  H.focusGet().then((f) => { if (f) set(f); });

  window.__focus = { get current() { return cur; }, allows, blocked, dialog, begin, end, extend, menu };
})();
