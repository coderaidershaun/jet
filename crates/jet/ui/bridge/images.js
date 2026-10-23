// Resolve pictures against the app that produced the tool result.
export async function readAppImage(request, appId, picture) {
  const unavailable = () => { throw new Error('Picture unavailable: use a contained image from a registered app.'); };
  const apps = await request('/api/apps');
  const app = apps.find(app => app.id === appId);
  if (!app || app.embedding !== 'relative-paths' || !/^[a-zA-Z0-9_-]+$/.test(appId)) unavailable();
  if (typeof picture !== 'string' || !picture || /[\x00-\x20\x7f\\]/.test(picture) || /%(?![a-f\d]{2})/i.test(picture)) unavailable();
  const rawPath = picture.split(/[?#]/, 1)[0];
  const absolute = /^https?:\/\//i.test(picture);
  const path = absolute ? rawPath.replace(/^https?:\/\/[^/]+/i, '') : rawPath;
  if (!absolute && (path.startsWith('/') || path.includes(':'))) unavailable();
  for (const segment of path.split('/')) {
    let current = segment;
    for (let pass = 0; pass < 8; pass++) {
      if (current === '.' || current === '..' || /[\x00-\x1f\x7f/\\]/.test(current)) unavailable();
      if (!current.includes('%')) break;
      if (/%(?![a-f\d]{2})/i.test(current)) { if (pass === 0) unavailable(); break; }
      let decoded;
      try { decoded = decodeURIComponent(current); } catch { unavailable(); }
      if (decoded === current) break;
      if (pass === 7) unavailable();
      current = decoded;
    }
  }
  let base, url;
  try { base = new URL(app.baseUrl); url = new URL(picture, base); } catch { unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(base.pathname)) unavailable();
  const suffix = url.pathname.slice(base.pathname.length);
  if (suffix.startsWith('apps/')) unavailable();
  return `/apps/${appId}/${suffix}${url.search}${url.hash}`;
}
