// Shows what the dials turned into: the rows a clip reports about itself, and
// the progress bar under Jet, one segment per phase of the clip.

/**
 * @param {string} name
 * @param {import('../jet/clip.js').Clip} clip
 */
export function renderReadout(name, clip) {
  document.getElementById('clip-name').textContent = name;
  document.getElementById('duration').textContent = (clip.total / 1000).toFixed(2) + ' s';
  document.getElementById('readout').innerHTML = clip.readout
    .map((row) => '<div><b>' + row.label + '</b><em class="' + (row.on ? 'on' : '') + '">' + row.value + '</em></div>')
    .join('');
  // built as nodes rather than markup: the page's CSP allows no inline style attributes
  const bar = document.getElementById('progress');
  bar.replaceChildren();
  let start = 0;
  for (const phase of clip.phases) {
    const segment = document.createElement('div');
    segment.className = 'bar-seg';
    segment.style.flex = String(Math.max(1, (phase.end - start) / 100));
    start = phase.end;
    const track = document.createElement('div');
    track.className = 'seg';
    track.append(document.createElement('i'));
    const label = document.createElement('div');
    label.className = 'lab';
    label.textContent = phase.name;
    segment.append(track, label);
    bar.append(segment);
  }
}

/**
 * @param {import('../jet/player.js').Progress | null} progress
 */
export function renderProgress(progress) {
  const fills = document.querySelectorAll('#progress .seg i');
  fills.forEach((fill, i) => {
    const value = progress ? progress.phases[i] || 0 : 0;
    /** @type {HTMLElement} */ (fill).style.width = value * 100 + '%';
  });
}
