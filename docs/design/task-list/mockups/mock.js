// The sample list and the drawing of every mockup screen: one function that takes a state as data and writes the page,
// in the markup and class names the build should give view.js and rows.js. Sample date: Thursday 26 November 2026.
window.Mock = (() => {
  const LONG = 'Write the alt text, captions and the reduced-motion fallback for every kite animation on the landing page before the Friday review with Sam';

  const goals = [
    { id: 2, title: 'Q4 report for the board', deliverable: 'A ten-page report on the fourth quarter for the board meeting on 3 December, with revenue by region and the plan for next year', due: 'Tue 24 Nov', left: '2 days overdue', overdue: true, paused: false, tasks: 5, done: 1 },
    { id: 1, title: 'Ship the kite page', deliverable: 'The kite page live on jet.example with the new animations', due: 'Mon 30 Nov', left: '4 days left', overdue: false, paused: false, tasks: 7, done: 3 },
    { id: 3, title: 'Hire a designer', deliverable: 'A signed offer to a product designer who starts in January', due: 'Fri 18 Dec', left: 'Paused', overdue: false, paused: true, tasks: 2, done: 0 },
  ];
  /** Open tasks in the user's one order. `lateDays` comes from `date` and `today`; `since` from `startedAt`; `soon` from `date`. */
  const baseTasks = [
    { id: 20, title: 'Return the library books', goal: null, state: 'not_started', day: 'today', date: 'Sun 22 Nov', lateDays: 4 },
    { id: 1, title: 'Review the board deck numbers with finance', goal: 2, state: 'not_started', day: 'today', date: 'Mon 23 Nov', lateDays: 3 },
    { id: 2, title: 'Draft the kite page copy', goal: 1, state: 'in_progress', day: 'today', date: 'Thu 26 Nov', since: 'since Tue' },
    { id: 21, title: 'Reply to the landlord about the boiler', goal: null, state: 'not_started', day: 'today', date: 'Tue 24 Nov', lateDays: 2 },
    { id: 22, title: 'Pay the parking fine', goal: null, state: 'not_started', day: 'today', date: 'Wed 25 Nov', lateDays: 1 },
    { id: 3, title: 'Call the bank about the business account', goal: null, state: 'not_started', day: 'today', date: 'Wed 25 Nov', lateDays: 1 },
    { id: 4, title: 'Pick up the dry cleaning', goal: null, state: 'not_started', day: 'today', date: 'Thu 26 Nov' },
    { id: 5, title: LONG, goal: 1, state: 'in_progress', day: 'today', date: 'Thu 26 Nov', since: 'since 09:30' },
    { id: 6, title: 'Book the venue for the team dinner', goal: null, state: 'not_started', day: 'tomorrow', date: 'Fri 27 Nov' },
    { id: 7, title: 'Send the report outline to Sam', goal: 2, state: 'not_started', day: 'tomorrow', date: 'Fri 27 Nov' },
    { id: 13, title: 'Test the kite page on a phone', goal: 1, state: 'not_started', day: 'tomorrow', date: 'Fri 27 Nov' },
    { id: 14, title: 'Chart the Q4 revenue by region', goal: 2, state: 'in_progress', day: 'later', date: 'Wed 2 Dec', soon: 'in 6 days', since: 'since 16 Nov · 10 days' },
    { id: 8, title: 'Record the launch video', goal: 1, state: 'not_started', day: 'later', date: 'Mon 30 Nov', soon: 'in 4 days' },
    { id: 9, title: 'Shortlist three portfolios', goal: 3, state: 'not_started', day: 'later', date: 'Fri 4 Dec' },
    { id: 15, title: 'Write the summary page', goal: 2, state: 'not_started', day: 'later', date: null },
    { id: 16, title: 'Write the job post', goal: 3, state: 'not_started', day: 'later', date: null },
    { id: 10, title: 'Renew the domain', goal: null, state: 'not_started', day: 'later', date: null },
  ];
  const done = [
    { id: 12, title: 'Email the accountant', goal: null, at: '09:12' },
    { id: 11, title: 'Sketch the kite poses', goal: 1, at: '08:40' },
  ];
  const DONE_COUNT = 14;

  const PATHS = {
    check: 'M5 12.5l4.5 4.5L19 7.5', dash: 'M7 12h10', chevron: 'M6 9l6 6 6-6', plus: 'M12 5v14M5 12h14',
    alert: 'M12 8v5M12 16.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', more: 'M5 12h.01M12 12h.01M19 12h.01',
    menu: 'M4 7h16M4 12h16M4 17h16', tasks: 'M4 6h4v4H4zM4 14h4v4H4zM12 8h8M12 16h8', files: 'M6 3h8l4 4v14H6zM14 3v4h4',
    chat: 'M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.2A8 8 0 1 1 21 12z', info: 'M12 11v5M12 7.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  };
  const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const goalOf = (id) => goals.find((g) => g.id === id) ?? null;
  const isLate = (t) => Boolean(t.lateDays);
  const rank = (t) => (isLate(t) ? 0 : t.day === 'today' ? 1 : t.day === 'tomorrow' ? 2 : 3);
  const STATE = { not_started: 'not started', in_progress: 'in progress', done: 'done' };
  const lateWords = (t) => `${t.lateDays} day${t.lateDays === 1 ? '' : 's'} late`;

  function render(root, cfg = {}) {
    const tasks = cfg.tasks ?? baseTasks;
    const focus = new Set(cfg.focus ?? []);
    const f = (key) => (focus.has(key) ? ' mk-focus' : '');
    const counts = {
      late: tasks.filter(isLate).length,
      today: tasks.filter((t) => t.day === 'today' && !isLate(t)).length,
      progress: tasks.filter((t) => t.state === 'in_progress').length,
      done: done.length,
    };
    const goalCounts = (g) => { const open = tasks.filter((t) => t.goal === g.id); return { progress: open.filter((t) => t.state === 'in_progress').length, late: open.filter(isLate).length }; };
    const pred = cfg.filter === 'late' ? isLate : cfg.filter === 'today' ? (t) => t.day === 'today' && !isLate(t)
      : cfg.filter === 'progress' ? (t) => t.state === 'in_progress' : cfg.filter === 'done' ? () => false
      : cfg.goal ? (t) => t.goal === cfg.goal : () => true;
    const donePred = cfg.filter && cfg.filter !== 'done' ? () => false : cfg.goal ? (t) => t.goal === cfg.goal : () => true;
    const filtered = Boolean(cfg.filter || cfg.goal);

    // ---- The drawer and the head band (the drawer is the app's, shown for fit).
    const drawerCount = counts.late ? `<span class="late">${icon('alert')}${counts.late}</span><span>· ${counts.today}</span>` : counts.today ? `<span>${counts.today}</span>` : '';
    const drawerName = counts.late ? `Task list, ${counts.late} overdue, ${counts.today} due today` : counts.today ? `Task list, ${counts.today} due today` : 'Task list';
    const drawer = `<nav class="mk-drawer" aria-label="Chats"><div class="mk-id"><span class="mk-kite" aria-hidden="true"></span><div><p class="mk-name">Jet</p><p class="mk-sub">Personal assistant</p></div></div>
      <div class="mk-nav"><button class="mk-row is-current" aria-current="page" aria-label="${drawerName}">${icon('tasks')}Task list<span class="mk-count" aria-hidden="true">${cfg.kind === 'full' || !cfg.kind ? drawerCount : ''}</span></button><button class="mk-row">${icon('files')}Files</button></div>
      <p class="mk-label">Chats</p><div class="mk-chat">${['Main chat', 'Ship the kite page', 'Q4 report for the board', 'Hire a designer'].map((c) => `<button class="mk-row">${icon('chat')}${c}</button>`).join('')}</div></nav>`;
    const head = `<header class="tl-head"><button class="tl-chats" aria-label="Chats">${icon('menu')}</button><h1 class="tl-title-head" id="tasks-title" tabindex="-1">Task list</h1></header>`;

    // ---- Parts.
    const summary = () => `<div class="tl-summary" role="toolbar" aria-label="Show only">${[
      ['late', counts.late, 'Overdue'], ['today', counts.today, 'Due today'], ['progress', counts.progress, 'In progress'], ['done', counts.done, 'Done today']]
      .map(([k, v, w], i) => `<button type="button" class="tl-sum${f(`sum-${k}`)}" data-kind="${k}" data-some="${v > 0}" aria-pressed="${cfg.filter === k}" tabindex="${i === 0 ? 0 : -1}"><span class="tl-sum-n">${k === 'late' && v ? icon('alert') : ''}${v}</span><span class="tl-sum-w">${w}</span></button>`).join('')}</div>`;

    const add = (a = {}) => `<form class="tl-add${a.active || a.text ? ' is-active' : ''}" aria-label="Add a task">${icon('plus')}
      <input class="tl-add-field${f('add')}" aria-label="New task title" placeholder="${a.disabled ? 'Loading the list…' : 'Add a task'}" value="${esc(a.text ?? '')}" maxlength="300" enterkeyhint="done" aria-keyshortcuts="N"${a.disabled ? ' disabled' : ''}${a.error ? ' aria-invalid="true" aria-describedby="add-error"' : ''}>
      <span class="tl-add-opts"><select class="tl-select" aria-label="Day"${a.disabled ? ' disabled' : ''}><option>${a.day ?? 'Today'}</option></select><select class="tl-select" aria-label="Goal"${a.disabled ? ' disabled' : ''}><option>${esc(a.goal ?? 'No goal')}</option></select></span>
      <button class="tl-primary" type="submit"${a.disabled ? ' disabled' : ''}>Add</button></form>${a.error ? `<p class="tl-add-error" id="add-error">${icon('alert')}<span>The task could not be added. Jet could not be reached. Press Add to try again.</span></p>` : ''}`;

    function chip(t) {
      const name = isLate(t) ? `Was due ${t.date}. Move` : t.date ? `Due ${t.date}${t.soon ? `, ${t.soon}` : ''}. Move` : 'Later, no date. Move';
      const open = cfg.menu === t.id;
      let inner, tone;
      if (isLate(t)) { tone = 'late'; inner = `${icon('alert')}${lateWords(t)}`; }
      else if (t.day === 'today' || t.day === 'tomorrow') { tone = 'move'; inner = 'Move'; }
      else { tone = 'date'; inner = t.soon ? `<span class="tl-chip-date">${t.date} · </span>${t.soon}` : (t.date ?? 'No date'); }
      const menu = open ? `<div class="tl-menu" role="menu" aria-label="Move ${esc(t.title)}">${['today', 'tomorrow', 'later'].map((d) => {
        const on = d === t.day && !isLate(t);
        return `<button role="menuitemradio" class="${f(`menu-${d}`).trim()}" aria-checked="${on}">${d[0].toUpperCase() + d.slice(1)}${on ? icon('check') : ''}</button>`;
      }).join('')}${isLate(t) ? `<p class="tl-menu-foot">Was due ${t.date}</p>` : ''}</div>` : '';
      return `<button type="button" class="tl-chip${f(`chip-${t.id}`)}" data-tone="${tone}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${esc(name)}">${inner}${icon('chevron')}</button>${menu}`;
    }

    function meta(t) {
      const g = goalOf(t.goal);
      const parts = [];
      if (t.state === 'in_progress' && t.since) parts.push(`<span class="tl-since">In progress ${t.since}</span>`);
      if (g) parts.push(`<span class="tl-meta-goal">${esc(g.title)}</span>`);
      return parts.length ? `<p class="tl-meta">${parts.join('')}</p>` : '';
    }
    const markBox = (t, state) => `<button type="button" class="tl-mark${f(`mark-${t.id}`)}" role="checkbox" aria-checked="${state === 'done' ? 'true' : state === 'in_progress' ? 'mixed' : 'false'}" aria-label="${esc(t.title)}, ${STATE[state]}" aria-keyshortcuts="1 2 3"><span class="tl-box">${state === 'done' ? icon('check') : state === 'in_progress' ? icon('dash') : ''}</span></button>`;

    function strip(t) {
      const late = isLate(t);
      const g = goalOf(t.goal);
      const seg = (items, cur) => `<span class="tl-seg" role="group">${items.map(([k, w]) => `<button type="button" class="${f(`seg-${k}`).trim()}" aria-pressed="${k === cur}">${w}</button>`).join('')}</span>`;
      const off = late ? ' aria-disabled="true" aria-describedby="why-step"' : '';
      return `<div class="tl-strip" role="group" aria-label="Change ${esc(t.title)}">
        <div class="tl-strip-line"><span class="tl-label">Status</span>${seg([['not_started', 'Not started'], ['in_progress', 'In progress'], ['done', 'Done']], t.state)}</div>
        <div class="tl-strip-line"><span class="tl-label">Day</span>${seg([['today', 'Today'], ['tomorrow', 'Tomorrow'], ['later', 'Later']], late ? '' : t.day)}${late ? `<span class="tl-why">${icon('info')}<span>Was due ${t.date}. Today gives it today's date.</span></span>` : ''}</div>
        <div class="tl-strip-line"><span class="tl-label">Goal</span><select class="tl-select" aria-label="Goal"><option>${g ? esc(g.title) : 'No goal'}</option></select></div>
        <div class="tl-strip-line"><button class="tl-text-btn"${off}>Up</button><button class="tl-text-btn"${off}>Down</button><button class="tl-text-btn">${icon('chat')}Open chat</button><button class="tl-text-btn tl-delete tl-push">Delete</button>
          ${late ? `<span class="tl-why" id="why-step">${icon('info')}<span>An overdue task keeps its place. Use Day or its chip to move it.</span></span>` : ''}</div></div>`;
    }

    function row(t) {
      if (cfg.open === t.id) return `<li class="tl-row tl-task" data-state="${t.state}" data-open="true"><div class="tl-line">${markBox(t, t.state)}<textarea class="tl-field${f('field')}" rows="1" aria-label="Task title" maxlength="300">${esc(t.title)}</textarea></div>${strip(t)}</li>`;
      const lingering = cfg.linger === t.id;
      const state = lingering ? 'done' : t.state;
      const right = lingering ? `<span class="tl-time">Done 10:02</span>` : chip(t);
      return `<li class="tl-row tl-task${lingering ? ' is-lingering' : ''}" data-state="${state}" data-open="false" data-late="${isLate(t)}">
        <div class="tl-line">${markBox(t, state)}<div class="tl-main"><button type="button" class="tl-title${f(`title-${t.id}`)}" title="${esc(t.title)}" aria-expanded="false" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">${esc(t.title)}</button>${lingering ? (goalOf(t.goal) ? `<p class="tl-meta"><span class="tl-meta-goal">${esc(goalOf(t.goal).title)}</span></p>` : '') : meta(t)}</div>${right}</div></li>`;
    }
    const doneRow = (t) => `<li class="tl-row tl-task" data-state="done" data-open="false"><div class="tl-line">${markBox(t, 'done')}<div class="tl-main"><button type="button" class="tl-title" title="${esc(t.title)}">${esc(t.title)}</button>${t.goal ? `<p class="tl-meta"><span class="tl-meta-goal">${esc(goalOf(t.goal).title)}</span></p>` : ''}</div><span class="tl-time">${t.at}</span></div></li>`;

    function section(day, title, list, { date = '', extra = '', empty = '' } = {}) {
      if (!list.length && filtered && !extra) return '';
      const late = day === 'late';
      const shown = late && !cfg.showAllLate ? list.slice(0, 3) : list;
      const rest = list.length - shown.length;
      const moveAll = late ? `<button type="button" class="tl-text-btn${cfg.armed ? ' is-armed' : ''}${f('move-all')}">${cfg.armed ? `Move ${list.length} to Today?` : 'Move all to Today'}</button>` : '';
      return `<section class="tl-section" data-day="${day}" aria-labelledby="tl-h-${day}"><div class="tl-heading"><h2 id="tl-h-${day}">${late ? icon('alert') : ''}${title}</h2>${date ? `<span class="tl-date">${date}</span>` : ''}${list.length ? `<span class="tl-count">${list.length} ${filtered ? 'shown' : 'open'}</span>` : '<span class="tl-count"></span>'}${moveAll}</div>
        <ul class="tl-list" aria-label="${title}">${shown.map(row).join('') || (empty ? `<li class="tl-quiet">${empty}</li>` : '')}</ul>
        ${rest > 0 ? `<button type="button" class="tl-text-btn tl-more" aria-expanded="false">Show ${rest} more overdue${icon('chevron')}</button>` : late && cfg.showAllLate && list.length > 3 ? `<button type="button" class="tl-text-btn tl-more" aria-expanded="true">Show fewer overdue</button>` : ''}${extra}</section>`;
    }

    /** The goal's details behind its "⋯": deliverable, title field, Open chat, and Mark done that arms first. */
    function details(g) {
      if (cfg.goalOpen !== g.id) return '';
      const open = tasks.filter((t) => t.goal === g.id).length;
      const ask = open ? `Done? Its ${open} open task${open === 1 ? '' : 's'} leave${open === 1 ? 's' : ''} the list.` : 'Done?';
      return `<div class="tl-goal-details" id="goal-details-${g.id}" role="group" aria-label="Change ${esc(g.title)}">
        <p class="tl-deliverable" title="${esc(g.deliverable)}">${esc(g.deliverable)}</p>
        <input class="tl-goal-field${f(`goal-field-${g.id}`)}" aria-label="Goal title" value="${esc(g.title)}" maxlength="200" enterkeyhint="done">
        <div class="tl-goal-actions"><button type="button" class="tl-text-btn">${icon('chat')}Open chat</button><button type="button" class="tl-text-btn tl-delete tl-push${cfg.goalArmed ? ' is-armed' : ''}${f(`goal-done-${g.id}`)}">${cfg.goalArmed ? ask : 'Mark done'}</button></div></div>`;
    }
    function goalCard(g) {
      const c = goalCounts(g);
      const next = tasks.filter((t) => t.goal === g.id).sort((a, b) => rank(a) - rank(b))[0];
      const when = next ? (isLate(next) ? lateWords(next) : next.day === 'today' ? 'Today' : next.day === 'tomorrow' ? 'Tomorrow' : next.date ?? 'No date') : '';
      const pressed = cfg.goal === g.id;
      const pct = (n) => `${(100 * n) / g.tasks}%`;
      return `<div class="tl-goal${pressed ? ' is-pressed' : ''}"><div class="tl-goal-top"><button type="button" class="tl-goal-name${f(`goal-${g.id}`)}" aria-pressed="${pressed}">${esc(g.title)}</button><button type="button" class="tl-goal-more" aria-label="More about ${esc(g.title)}" aria-expanded="${cfg.goalOpen === g.id}" aria-controls="goal-details-${g.id}">${icon('more')}</button></div>
        <div class="tl-bar" role="img" aria-label="${g.done} of ${g.tasks} done, ${c.progress} in progress"><span class="tl-bar-done" style="width:${pct(g.done)}"></span><span class="tl-bar-prog" style="width:${pct(c.progress)}"></span></div>
        <span class="tl-goal-facts">${g.done} of ${g.tasks} done · ${c.progress} in progress${c.late ? ` · <b>${c.late} late</b>` : ''}</span>
        <span class="tl-goal-due${g.overdue ? ' is-late' : ''}">${g.overdue ? icon('alert') : ''}${g.paused ? `Paused · due ${g.due}` : `Due ${g.due} · ${g.left}`}</span>
        ${next ? `<div class="tl-goal-next"><span><b>Next</b> · <span class="tl-next-when${isLate(next) ? ' is-late' : ''}">${when}</span></span><span class="tl-next-title" title="${esc(next.title)}">${esc(next.title)}</span></div>` : ''}${details(g)}</div>`;
    }
    const rail = () => `<section class="tl-goals" aria-labelledby="tl-h-goals-r"><h2 id="tl-h-goals-r">Goals</h2>${goals.map(goalCard).join('')}</section>`;
    function meter(g) {
      const c = goalCounts(g);
      const pressed = cfg.goal === g.id;
      const pct = (n) => `${(100 * n) / g.tasks}%`;
      return `<div class="tl-meter${pressed ? ' is-pressed' : ''}"><button type="button" class="tl-pick${f(`goal-${g.id}`)}" aria-pressed="${pressed}"><span class="tl-pick-name" title="${esc(g.title)}">${esc(g.title)}</span><span class="tl-pick-facts${g.overdue ? ' is-late' : ''}">${g.done}/${g.tasks} · ${g.paused ? 'Paused' : g.left}</span></button><button type="button" class="tl-goal-more" aria-label="More about ${esc(g.title)}" aria-expanded="${cfg.goalOpen === g.id}" aria-controls="goal-details-${g.id}">${icon('more')}</button>
        <div class="tl-bar" role="img" aria-label="${g.done} of ${g.tasks} done, ${c.progress} in progress"><span class="tl-bar-done" style="width:${pct(g.done)}"></span><span class="tl-bar-prog" style="width:${pct(c.progress)}"></span></div></div>${details(g)}`;
    }
    const band = () => `<section class="tl-goals tl-band" aria-labelledby="tl-h-goals-b"><h2 id="tl-h-goals-b">Goals</h2>${goals.map(meter).join('')}</section>`;

    const alerts = () => `${cfg.alert ? `<p class="tl-alert" role="alert">${cfg.alert}</p>` : ''}${cfg.notice ? `<p class="tl-notice">The task list could not be refreshed. <button class="tl-text-btn">Try again</button></p>` : ''}`;

    // ---- The page in each state.
    let column, side;
    switch (cfg.kind ?? 'full') {
      case 'full': {
        const late = tasks.filter((t) => isLate(t) && pred(t));
        const byDay = (d) => tasks.filter((t) => t.day === d && !isLate(t) && pred(t));
        const dt = done.filter(donePred).slice(0, 5);
        const doneToday = dt.length ? `<p class="tl-sub">Done today · ${dt.length}</p><ul class="tl-list" aria-label="Done today">${dt.map(doneRow).join('')}</ul>` : '';
        const filterLine = cfg.goal ? `<p class="tl-filter-line" role="status"><span>Showing <b>${esc(goalOf(cfg.goal).title)}</b>: ${tasks.filter((t) => t.goal === cfg.goal).length} open, ${goalOf(cfg.goal).done} done.</span> <button class="tl-text-btn${f('show-all')}">Show all</button></p>`
          : cfg.filter === 'progress' ? `<p class="tl-filter-line" role="status"><span>Showing <b>${counts.progress} in progress</b>.</span> <button class="tl-text-btn${f('show-all')}">Show all</button></p>` : '';
        column = `${alerts()}${summary()}${add(cfg.add)}${band()}${filterLine}
          ${late.length ? section('late', 'Overdue', late) : ''}
          ${section('today', 'Today', byDay('today'), { date: 'Thu 26 Nov', extra: doneToday, empty: 'Nothing else due today.' })}
          ${section('tomorrow', 'Tomorrow', byDay('tomorrow'), { date: 'Fri 27 Nov', empty: 'Nothing due tomorrow.' })}
          ${section('later', 'Later', byDay('later'), { empty: 'Nothing later.' })}
          <button type="button" class="tl-fold" aria-expanded="false">Done <span class="tl-count">${DONE_COUNT}</span>${icon('chevron')}</button>`;
        side = rail();
        break;
      }
      case 'empty':
        column = `${add({ active: true })}<section class="tl-section"><p style="margin:0 0 var(--tl-space-1);font-size:var(--tl-text-md);font-weight:var(--tl-weight-strong)">Nothing on your list yet.</p>
          <p class="tl-goal-invite" style="font-size:var(--tl-text-md)">Add a task above, or tell Jet what you are working on, for example <button class="tl-text-btn" style="display:inline;min-height:0;padding:0;font-size:inherit;font-weight:var(--tl-weight-normal);font-style:italic">“I need to ship the kite page by Friday.”</button></p></section>`;
        side = `<section class="tl-goals"><h2>Goals</h2><p class="tl-goal-invite">Jet makes a goal when you agree one in a chat.</p></section>`;
        root.dataset.drawerCount = '';
        break;
      case 'loading': {
        const skRow = `<li class="tl-row"><div class="tl-line"><span class="tl-mark"><span class="tl-skel-box"></span></span><span class="tl-skel" style="width:58%"></span></div></li>`;
        column = `<div class="tl-summary">${'<div class="tl-sum"><span class="tl-skel" style="width:28px;height:18px"></span><span class="tl-skel" style="width:70%;margin-top:var(--tl-space-2)"></span></div>'.repeat(4)}</div>
          ${add({ disabled: true })}<section class="tl-goals tl-band"><h2>Goals</h2>${'<div class="tl-meter"><span class="tl-skel" style="width:70%;margin:var(--tl-space-3) var(--tl-space-2)"></span><span></span><span class="tl-skel" style="height:4px;margin:0 var(--tl-space-2) var(--tl-space-2)"></span></div>'.repeat(2)}</section>
          <section class="tl-section"><div class="tl-heading"><span class="tl-skel" style="width:96px;margin-top:var(--tl-space-2)"></span></div><ul class="tl-list">${skRow.repeat(4)}</ul></section>`;
        side = `<section class="tl-goals"><h2>Goals</h2>${'<div class="tl-goal"><span class="tl-skel" style="width:70%;height:16px"></span><span class="tl-skel" style="height:6px;margin:var(--tl-space-1) 0"></span><span class="tl-skel" style="width:55%"></span><span class="tl-skel" style="width:45%"></span></div>'.repeat(2)}</section>`;
        break;
      }
      case 'error-first':
        column = `<div class="tl-state" role="alert"><p>The task list could not be loaded.</p><button class="tl-primary${f('retry')}">Try again</button></div>`;
        side = '';
        break;
      default: throw new Error(`render: unknown kind ${cfg.kind}`);
    }
    const busy = cfg.kind === 'loading' ? ' aria-busy="true"' : '';
    root.innerHTML = `<div class="mk-app">${drawer}<div class="mk-main"><section class="tasklist" aria-labelledby="tasks-title"${busy}>${head}
      <div class="tl-wrap${side ? '' : ' is-single'}"><div class="tl-column">${column}</div>${side ? `<aside class="tl-rail" aria-label="Goals">${side}</aside>` : ''}</div></section></div></div>
      <div class="sr-only" aria-live="polite">${cfg.kind === 'loading' ? 'Loading the task list' : ''}</div>`;
  }

  return { render, LONG, baseTasks };
})();
