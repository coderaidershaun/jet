// The sample list and drawing helpers that the three task list wireframes share: one user's list on Thu 26 Nov 2026,
// with every fact taken from what GET /api/task-list sends today, or worked out from it on the page.
window.WF = (() => {
  const LONG = 'Write the alt text, captions and the reduced-motion fallback for every kite animation on the landing page before the Friday review with Sam';

  /** Open goals, by due date. `tasks` and `done` are the server's counts; the rest the page works out from `tasks` below. */
  const goals = [
    { id: 2, title: 'Q4 report for the board', due: 'Tue 24 Nov', left: '2 days overdue', overdue: true, paused: false, tasks: 5, done: 1 },
    { id: 1, title: 'Ship the kite page', due: 'Mon 30 Nov', left: '4 days left', overdue: false, paused: false, tasks: 7, done: 3 },
    { id: 3, title: 'Hire a designer', due: 'Fri 18 Dec', left: 'Paused', overdue: false, paused: true, tasks: 2, done: 0 },
  ];

  /** Open tasks in the user's one order. `late` is the server's flag, `lateDays` the page's count from `date`. */
  const tasks = [
    { id: 1, title: 'Review the board deck numbers with finance', goal: 2, state: 'not_started', day: 'today', date: 'Mon 23 Nov', lateDays: 3 },
    { id: 2, title: 'Draft the kite page copy', goal: 1, state: 'in_progress', day: 'today', date: 'Thu 26 Nov' },
    { id: 3, title: 'Call the bank about the business account', goal: null, state: 'not_started', day: 'today', date: 'Wed 25 Nov', lateDays: 1 },
    { id: 4, title: 'Pick up the dry cleaning', goal: null, state: 'not_started', day: 'today', date: 'Thu 26 Nov' },
    { id: 5, title: LONG, goal: 1, state: 'in_progress', day: 'today', date: 'Thu 26 Nov' },
    { id: 6, title: 'Book the venue for the team dinner', goal: null, state: 'not_started', day: 'tomorrow', date: 'Fri 27 Nov' },
    { id: 7, title: 'Send the report outline to Sam', goal: 2, state: 'not_started', day: 'tomorrow', date: 'Fri 27 Nov' },
    { id: 13, title: 'Test the kite page on a phone', goal: 1, state: 'not_started', day: 'tomorrow', date: 'Fri 27 Nov' },
    { id: 14, title: 'Chart the Q4 revenue by region', goal: 2, state: 'in_progress', day: 'later', date: 'Wed 2 Dec' },
    { id: 8, title: 'Record the launch video', goal: 1, state: 'not_started', day: 'later', date: 'Mon 30 Nov' },
    { id: 9, title: 'Shortlist three portfolios', goal: 3, state: 'not_started', day: 'later', date: 'Fri 4 Dec' },
    { id: 15, title: 'Write the summary page', goal: 2, state: 'not_started', day: 'later', date: null },
    { id: 16, title: 'Write the job post', goal: 3, state: 'not_started', day: 'later', date: null },
    { id: 10, title: 'Renew the domain', goal: null, state: 'not_started', day: 'later', date: null },
  ];

  /** Done tasks, newest first; the read carries the newest 100 and `doneCount` counts all 90 days. */
  const done = [
    { id: 12, title: 'Email the accountant', goal: null, when: 'today', at: '09:12' },
    { id: 11, title: 'Sketch the kite poses', goal: 1, when: 'today', at: '08:40' },
    { id: 17, title: 'Pick the kite colours', goal: 1, when: 'Wed 25 Nov', at: '17:05' },
    { id: 18, title: 'Outline the Q4 report', goal: 2, when: 'Wed 25 Nov', at: '11:30' },
    { id: 19, title: 'Brief Jet on the kite page', goal: 1, when: 'Tue 24 Nov', at: '15:48' },
  ];
  const doneCount = 14;

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const goalOf = (id) => goals.find((goal) => goal.id === id) ?? null;
  const isLate = (task) => Boolean(task.lateDays);
  const STATE_WORDS = { not_started: 'not started', in_progress: 'in progress', done: 'done' };

  /** The status box: empty, half filled, or filled with a tick. Its name says the state in words. */
  const box = (state, title) => `<button class="box-btn" type="button" role="checkbox" aria-checked="${state === 'done' ? 'true' : state === 'in_progress' ? 'mixed' : 'false'}" aria-label="${esc(title)}, ${STATE_WORDS[state]}"><span class="box" data-s="${state}">${state === 'done' ? '✓' : ''}</span></button>`;

  /** The due words of an open task, and the chip's tone. */
  function due(task) {
    if (isLate(task)) return { words: `${task.lateDays} day${task.lateDays === 1 ? '' : 's'} late`, tone: 'late', full: `Was due ${task.date}` };
    if (task.day === 'today') return { words: 'Today', tone: 'today', full: `Due today, ${task.date}` };
    if (task.day === 'tomorrow') return { words: 'Tomorrow', tone: '', full: `Due tomorrow, ${task.date}` };
    return task.date ? { words: task.date, tone: '', full: `Due ${task.date}` } : { words: 'No date', tone: '', full: 'Later, no date' };
  }
  const chip = (task, extra = '') => {
    const d = due(task);
    return `<button type="button" class="chip${d.tone ? ` is-${d.tone}` : ''}" aria-haspopup="menu" aria-expanded="false" title="${esc(d.full)}" aria-label="${esc(d.full)}. Move">${d.tone === 'late' ? '! ' : ''}${esc(d.words)} <span class="caret" aria-hidden="true">▾</span></button>${extra}`;
  };

  /** Counts the page works out for the summary and for each goal: no new server fact. */
  const counts = {
    overdue: tasks.filter(isLate).length,
    today: tasks.filter((t) => t.day === 'today' && !isLate(t)).length,
    progress: tasks.filter((t) => t.state === 'in_progress').length,
    doneToday: done.filter((t) => t.when === 'today').length,
  };
  const goalCounts = (goal) => {
    const open = tasks.filter((t) => t.goal === goal.id);
    return { progress: open.filter((t) => t.state === 'in_progress').length, late: open.filter(isLate).length, open: open.length };
  };
  /** A goal's bar: done, then in progress, then the rest, as shares of all its tasks. */
  const bar = (goal) => {
    const c = goalCounts(goal);
    const pct = (n) => (goal.tasks ? (100 * n) / goal.tasks : 0);
    return `<div class="bar" role="img" aria-label="${goal.done} of ${goal.tasks} done, ${c.progress} in progress"><span class="done" style="width:${pct(goal.done)}%"></span><span class="prog" style="width:${pct(c.progress)}%"></span></div>`;
  };

  const drawer = (count = 5) => `<nav class="drawer" aria-label="Chats"><div class="brand"></div>
    <div class="nav" aria-current="page">▦ Task list <span class="count">${count}</span></div><div class="nav">▤ Files</div>
    <div class="chat-bar"></div><div class="chat-bar"></div><div class="chat-bar"></div><div class="chat-bar"></div><div class="chat-bar"></div></nav>`;
  const screen = (body, { count = 5 } = {}) => `<div class="screen">${drawer(count)}<div class="main"><div class="head"><span class="chats" aria-hidden="true"></span>Task list</div>${body}</div></div>`;
  const frame = (id, title, sub, body, notes = []) => `<section class="frame" id="${id}"><h2 class="frame-title">${title}<small>${sub}</small></h2>${body}${notes.length ? `<ol class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ol>` : ''}</section>`;
  const n = (i) => `<span class="callout" aria-hidden="true">${i}</span>`;

  return { LONG, goals, tasks, done, doneCount, counts, esc, goalOf, isLate, due, chip, box, bar, goalCounts, screen, frame, n, STATE_WORDS };
})();
