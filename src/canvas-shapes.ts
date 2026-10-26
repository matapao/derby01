export function drawArrow2(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  yaw: number,
  size: number,
  fill: string,
  outline: string,
  lw: number,
): void {
  c.save();
  c.translate(x, y);
  c.rotate(Math.atan2(Math.cos(yaw), Math.sin(yaw))); // heading (sin yaw, cos yaw) on a north-up map
  c.beginPath();
  c.moveTo(size, 0);
  c.lineTo(-size * 0.75, size * 0.68);
  c.lineTo(-size * 0.35, 0);
  c.lineTo(-size * 0.75, -size * 0.68);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = lw;
  c.strokeStyle = outline;
  c.stroke();
  c.restore();
}
