import { createPlayer } from '../../jet/player.js';
import { mountJet } from '../../jet/draw/view.js';
import { MODELS } from '../../bridge/models.js';

export function createDrawerView({ jetSvg, nameEl, titleEl, modelEl, tokensEl, barEl, percentEl, noteEl, gearButton, handlers }) {
  jetSvg.setAttribute('viewBox', '0 70 200 170');
  const draw = mountJet(jetSvg);
  const player = createPlayer({ standing: true, reducedMotion: true });
  player.tick(0);
  gearButton.addEventListener('click', handlers.openSettings);
  return {
    init() { draw(player.frame, { unitPx: Math.max(jetSvg.getBoundingClientRect().width / 200, 0.001) }); },
    setPersona({ name, jobTitle }) { nameEl.textContent = name; titleEl.textContent = jobTitle; },
    setContext(model, context = {}) {
      modelEl.textContent = MODELS.find(([id]) => id === model)?.[1] ?? model;
      const used = context.model === model ? context.usedTokens : null;
      const limit = context.model === model ? context.limitTokens : null;
      const count = value => value == null ? '—' : value.toLocaleString('en-GB');
      tokensEl.textContent = `${count(used)} / ${count(limit)} tokens`;
      tokensEl.title = `${count(used)} used / ${count(limit)} available tokens`;
      const known = used != null && limit > 0;
      barEl.hidden = !known;
      if (known) {
        const percentage = used / limit * 100;
        barEl.value = Math.min(100, percentage);
        barEl.setAttribute('aria-valuetext', `${percentage.toFixed(1)}% capacity used`);
        percentEl.textContent = `${Number(percentage.toFixed(1))}% capacity`;
      } else percentEl.textContent = 'Capacity unavailable';
      noteEl.textContent = used == null ? 'Context pending a reply' : context.estimated ? 'Last context estimate · aggregate usage' : 'Last measured context';
      if (used != null && !limit) noteEl.textContent += ' · limit unavailable';
    },
  };
}
