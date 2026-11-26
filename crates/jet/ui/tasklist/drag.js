// Dragging a task up and down and between days, by mouse and by a long press on touch. It moves a copy of the row,
// shows where it will land, and on the drop answers the day and the task it lands after. It knows no server.

const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;
const HOLD_MS = 350;
const EDGE = 48;

/**
 * @param {{ root: HTMLElement, scroller: HTMLElement, top: () => number, onStart: (id: number) => void,
 *   onDrop: (id: number, place: { day: string, after: number | null } | null, fromTop?: number) => void }} parts
 *   `root` holds the day lists: each `[data-drop-day]` section holds a `ul` of `[data-drag-id]` rows. `top` is the
 *   height the sticky head covers at the top of `scroller`. `onDrop` gets null for a drag that was cancelled or that
 *   lands where it started, and else where the copy was let go, so the row can settle from there.
 */
export function createDrag({ root, scroller, top, onStart, onDrop }) {
  let press = null, drag = null, swallow = false;

  const rows = (section) => [...section.querySelectorAll(':scope > ul > [data-drag-id]')];
  const days = () => [...root.querySelectorAll('[data-drop-day]')];

  /**
   * Where the middle of the lifted row lands: its day, and the rows of that day above it. Over the goals or the done
   * line it lands nowhere, and a drop there puts the row back.
   */
  function target(middle) {
    let found = null;
    for (const section of days()) {
      const box = section.getBoundingClientRect();
      if (middle < box.top || middle > box.bottom) continue;
      const others = rows(section).filter((row) => row !== drag.row);
      const above = others.filter((row) => { const r = row.getBoundingClientRect(); return r.top + r.height / 2 < middle; });
      found = { section, others, index: above.length };
    }
    return found;
  }

  function showLine(place) {
    drag.line.hidden = place === null;
    if (place === null) return;
    const { section, others, index } = place;
    const list = section.querySelector(':scope > ul').getBoundingClientRect();
    const anchor = index > 0 ? others[index - 1].getBoundingClientRect().bottom : others[0]?.getBoundingClientRect().top ?? list.top;
    drag.line.style.top = `${anchor - 1}px`;
    drag.line.style.left = `${list.left}px`;
    drag.line.style.width = `${list.width}px`;
  }

  function start() {
    // The list may have been drawn again since the press, so the row is found again by its id.
    const row = root.querySelector(`[data-drag-id="${press.id}"]`);
    const section = row?.closest('[data-drop-day]');
    if (!section || row.dataset.open === 'true') { press = null; return; }
    const { y } = press;
    const box = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.removeAttribute('id');
    for (const el of ghost.querySelectorAll('[id], [data-key]')) { el.removeAttribute('id'); el.removeAttribute('data-key'); }
    ghost.classList.add('tl-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px` });
    const line = document.createElement('div');
    line.className = 'tl-drop-line';
    document.body.append(ghost, line);
    row.classList.add('is-lifted');
    root.classList.add('is-dragging');
    const others = rows(section).filter((item) => item !== row);
    const startIndex = rows(section).indexOf(row);
    drag = { row, ghost, line, startY: y, y, offset: y - box.top, height: box.height, origin: { section, index: startIndex }, place: { section, others, index: startIndex }, frame: 0 };
    // Told only now, so that what it draws waits for the drop and the row under the pointer stays where it is.
    onStart(Number(row.dataset.dragId));
    try { root.setPointerCapture(press.pointerId); } catch (error) { console.warn('the drag could not hold the pointer:', error); }
    move(y);
    drag.frame = requestAnimationFrame(edgeScroll);
  }

  function move(y) {
    drag.y = y;
    drag.ghost.style.transform = `translateY(${y - drag.startY}px)`;
    drag.place = target(y - drag.offset + drag.height / 2);
    showLine(drag.place);
  }

  /** Near the top or bottom edge of the list it scrolls, faster the deeper the pointer is into the edge. */
  function edgeScroll() {
    if (!drag) return;
    const box = scroller.getBoundingClientRect();
    const fromTop = drag.y - (box.top + top()), fromBottom = box.bottom - drag.y;
    const depth = fromTop < EDGE ? -(EDGE - fromTop) : fromBottom < EDGE ? EDGE - fromBottom : 0;
    if (depth !== 0) {
      scroller.scrollTop += Math.sign(depth) * Math.min(12, 2 + Math.abs(depth) / 4);
      move(drag.y);
    }
    drag.frame = requestAnimationFrame(edgeScroll);
  }

  /** Ends a drag; `dropped` is false for a cancel, which makes no call. */
  function finish(dropped) {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
    if (!drag) return;
    const { row, ghost, line, origin, place, frame } = drag;
    drag = null;
    cancelAnimationFrame(frame);
    const fromTop = ghost.getBoundingClientRect().top;
    ghost.remove();
    line.remove();
    row.classList.remove('is-lifted');
    root.classList.remove('is-dragging');
    // The click that follows a drop comes in the same turn as the pointer's release; a later one is the person's own.
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
    const moved = place !== null && (place.section !== origin.section || place.index !== origin.index);
    if (!dropped || !moved) { onDrop(Number(row.dataset.dragId), null); return; }
    const after = place.index > 0 ? Number(place.others[place.index - 1].dataset.dragId) : null;
    onDrop(Number(row.dataset.dragId), { day: place.section.dataset.dropDay, after }, fromTop);
  }

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    const row = event.target.closest('[data-drag-id]');
    // An open row is a place to drop beside, but it is being edited, so it is not lifted.
    if (!row || !root.contains(row) || row.dataset.open === 'true' || event.target.closest('.tl-mark, input, select, textarea, .tl-strip')) return;
    press = { id: row.dataset.dragId, x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch: event.pointerType !== 'mouse' };
    if (press.touch) press.timer = setTimeout(start, HOLD_MS);
  });
  root.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.pointerId) return;
    if (drag) { move(event.clientY); return; }
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (press.touch && distance > TOUCH_SLOP) { clearTimeout(press.timer); press = null; }
    else if (!press.touch && distance > MOUSE_SLOP) start();
  });
  // Once a touch drag has started the list must not scroll under the finger.
  root.addEventListener('touchmove', (event) => { if (drag) event.preventDefault(); }, { passive: false });
  root.addEventListener('pointerup', () => finish(true));
  root.addEventListener('pointercancel', () => finish(false));
  // Taking the pointer from the row it touched makes the row lose it first, which is not the end of the drag.
  root.addEventListener('lostpointercapture', (event) => { if (drag && event.target === root) finish(false); });
  root.addEventListener('contextmenu', (event) => { if (press?.touch) event.preventDefault(); });
  root.addEventListener('click', (event) => {
    if (!swallow) return;
    swallow = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  addEventListener('blur', () => finish(false));
  document.addEventListener('keydown', (event) => {
    if (!drag || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(false);
  }, true);

  return { get dragging() { return drag !== null; } };
}
