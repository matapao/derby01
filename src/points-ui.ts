/** Local score popups; never imported by simulation rules. */
export function popPoints(h: { hud?: { pts: HTMLElement } | null }, text: string, cls = ''): void {
  if (!h.hud) return;
  const d = document.createElement('div');
  d.className = 'pop ' + cls;
  d.textContent = text;
  h.hud.pts.appendChild(d);
  setTimeout(() => d.remove(), 1900);
  while (h.hud.pts.children.length > 3) h.hud.pts.firstElementChild?.remove();
}
