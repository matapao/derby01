import { isRenderMode, type RenderMode } from './render-quality.ts';

export function mountPictureControls(
  opening: () => void,
  picture: { get(): RenderMode; set(mode: RenderMode): void },
  doc: Document = document,
) {
  const dialog = doc.createElement('dialog');
  dialog.className = 'utility-dialog picture-dialog';
  dialog.setAttribute('aria-labelledby', 'pictureTitle');
  const header = doc.createElement('header');
  const title = doc.createElement('h2');
  title.id = 'pictureTitle';
  title.textContent = 'Picture';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'btn small';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close picture controls');
  header.append(title, close);
  const label = doc.createElement('label');
  label.textContent = 'Picture ';
  const select = doc.createElement('select');
  select.dataset['picture'] = '';
  for (const [value, text] of [
    ['auto', 'Auto · clear and adaptive'],
    ['performance', 'Older laptop · lower GPU load'],
    ['sharp', 'Sharp · more detail'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = picture.get();
  label.append(select);
  dialog.append(header, label);
  doc.body.append(dialog);
  let disposed = false;
  const change = () => {
    if (isRenderMode(select.value)) picture.set(select.value);
    else select.value = picture.get();
  };
  const dismiss = () => dialog.close();
  const stopInput = (event: Event) => event.stopPropagation();
  const inputEvents = ['keydown', 'keyup', 'pointerdown', 'pointerup'];
  select.addEventListener('change', change);
  close.addEventListener('click', dismiss);
  for (const event of inputEvents) dialog.addEventListener(event, stopInput);
  return {
    open() {
      if (disposed || dialog.open) return;
      select.value = picture.get();
      opening();
      dialog.showModal();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      select.removeEventListener('change', change);
      close.removeEventListener('click', dismiss);
      for (const event of inputEvents) dialog.removeEventListener(event, stopInput);
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
