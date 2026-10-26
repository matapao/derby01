export type PaintLayerContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'clearRect'
  | 'drawImage'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'globalAlpha'
  | 'globalCompositeOperation'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
>;

export interface PaintSurface {
  cv: CanvasImageSource;
  w: number;
  h: number;
  cover: number;
  ang: number;
  wipers: readonly { x: number; y: number; len: number }[];
  crack: { cv: CanvasImageSource; level: number } | null;
}

/** Cockpit glass is already drawn in 3D; turret feeds have their own painted camera lenses. */
export function paintViewSurface(
  seat: number,
  camMode: string,
  active: boolean,
): 'shield' | 'hood' | 'trunk' | null {
  if (!active) return null;
  if (seat === 0 && camMode === 'chase') return 'shield';
  if (seat === 1) return 'hood';
  if (seat === 2) return 'trunk';
  return null;
}

/** Camera paint clears uniformly, without an invisible windshield sweep. Limit tab-resume jumps. */
export function fadeCameraPaint(
  context: PaintLayerContext,
  width: number,
  height: number,
  cover: number,
  dt: number,
): number {
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(cover) || cover <= 0) return cover;
  if (cover < 0.003) {
    context.clearRect(0, 0, width, height);
    return 0;
  }
  const retained = Math.exp(-0.35 * Math.min(dt, 0.25));
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.globalAlpha = 1;
  context.fillStyle = `rgba(0,0,0,${1 - retained})`;
  context.fillRect(0, 0, width, height);
  context.restore();
  return Math.min(1, cover) * retained;
}

/** Only a car windshield has cracks or blades. A camera feed can show paint, never glass effects. */
export function drawPaintLayer(
  context: PaintLayerContext,
  surface: PaintSurface,
  width: number,
  height: number,
  windshield: boolean,
): void {
  context.save();
  if (windshield && surface.crack && surface.crack.level > 0)
    context.drawImage(surface.crack.cv, 0, 0, width, height);
  context.globalAlpha = windshield ? 0.8 : 0.94;
  context.drawImage(surface.cv, 0, 0, width, height);
  context.globalAlpha = 1;
  if (windshield) {
    const sx = width / surface.w;
    const sy = height / surface.h;
    const angle = surface.ang + Math.PI;
    context.lineCap = 'round';
    for (const blade of surface.wipers) {
      const x = blade.x * sx;
      const y = blade.y * sy;
      const endX = x + Math.cos(angle) * blade.len * sx;
      const endY = y + Math.sin(angle) * blade.len * sy;
      context.strokeStyle = `rgba(10,10,12,${surface.cover > 0.04 ? 0.9 : 0.5})`;
      context.lineWidth = Math.max(3, height * 0.011);
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(endX, endY);
      context.stroke();
      context.strokeStyle = 'rgba(255,255,255,0.22)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x - 2, y - 1);
      context.lineTo(endX - 2, endY - 1);
      context.stroke();
    }
  }
  context.restore();
}
