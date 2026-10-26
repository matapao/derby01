/** Required drawing surfaces fail at setup rather than halfway through a frame. */
export function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  return context;
}

export function requiredElement<T extends Element>(
  selector: string,
  type: new () => T,
  root: ParentNode = document,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Missing or invalid element: ${selector}`);
  return element;
}

export function dataValue(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (!Object.hasOwn(element.dataset, key) || typeof value !== 'string')
    throw new Error(`Missing data-${key}`);
  return value;
}

const htmlCache = new WeakMap<HTMLElement, string>();
/** Callers own escaping; this only avoids replacing the same trusted presentation markup each frame. */
export function setHtml(element: HTMLElement, html: string): void {
  if (htmlCache.get(element) === html && element.innerHTML === html) return;
  element.innerHTML = html;
  htmlCache.set(element, html);
}
