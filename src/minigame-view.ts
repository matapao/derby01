/** Canvas presentation only; minigame state transitions live in gameplay/minigames.ts. */
import { TAU, clamp, rand } from './core.ts';
import type { ActiveGame, GameStates, MiniCar, MiniGameKind, MiniRules } from './gameplay/minigames.ts';
import type { Direction } from './gameplay/input.ts';
type Context = CanvasRenderingContext2D;
interface DrawingHelpers {
  arrow(c: Context, x: number, y: number, direction: Direction, size: number, color: string): void;
  flame(c: Context, x: number, y: number, size: number, time: number): void;
  rect(c: Context, x: number, y: number, width: number, height: number, radius: number): void;
}
type GameViews<C extends MiniCar> = {
  [K in MiniGameKind]: {
    draw(c: Context, game: GameStates[K], x: number, y: number, w: number, h: number, car?: C): void;
  };
};
export function createMiniGameViews<C extends MiniCar>(
  rules: MiniRules,
  canFuel: () => number,
  helpers: DrawingHelpers,
): GameViews<C> {
  const { arrow: drawArrow, flame: drawFlame, rect: roundRect } = helpers;
  const UI_FONT = '"Barlow Condensed", "Arial Narrow", sans-serif';
  return {
    glue: {
      draw(c, g, x, y, w, h) {
        const px = x + 12,
          py = y + 18,
          pw = w - 70,
          ph = h - 34;
        c.fillStyle = '#5b6067';
        c.fillRect(px, py + 10, pw, ph - 10); // the car body
        c.fillStyle = '#1c1c1f';
        roundRect(c, px - 4, py + ph * 0.45, pw + 8, ph * 0.4, ph * 0.2);
        c.fill(); // the rubber
        c.fillStyle = '#ffc24b';
        c.fillRect(px - 4, py + ph * 0.42, pw + 8, 4);
        // the seam along the top edge, bead grows with progress
        c.setLineDash([5, 5]);
        c.strokeStyle = '#cfd3d8';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(px, py + 3);
        c.lineTo(px + pw, py + 3);
        c.stroke();
        c.setLineDash([]);
        const bx = px + pw * clamp(g.prog, 0, 1);
        c.strokeStyle = '#8a5a3c';
        c.lineWidth = 6;
        c.beginPath();
        c.moveTo(px, py + 3);
        c.lineTo(bx, py + 3);
        c.stroke();
        if (g.good) {
          c.fillStyle = '#fff2b0';
          c.beginPath();
          c.arc(bx, py + 3, 7, 0, TAU);
          c.fill();
          for (let i = 0; i < 6; i++) {
            c.fillStyle = `rgba(255,${(180 + Math.random() * 70) | 0},80,0.9)`;
            c.fillRect(bx + rand(-16, 16), py + rand(-14, 12), 2, 2);
          }
        }
        // heat gauge
        const gx = x + w - 44,
          gh = h - 34;
        c.fillStyle = '#1b1822';
        c.fillRect(gx, py, 26, gh);
        const band = rules.glue;
        c.fillStyle = 'rgba(99,224,139,0.55)';
        c.fillRect(gx, py + gh * (1 - band.high), 26, gh * (band.high - band.low));
        c.fillStyle = 'rgba(255,84,104,0.6)';
        c.fillRect(gx, py, 26, gh * 0.12);
        c.fillStyle = g.burn > 0 ? '#ff5468' : '#ffc24b';
        c.fillRect(gx - 4, py + gh * (1 - clamp(g.heat, 0, 1)) - 2, 34, 4);
        if (g.burn > 0) {
          c.fillStyle = '#ff5468';
          c.font = 'bold 16px "Barlow Condensed", sans-serif';
          c.textAlign = 'center';
          c.fillText('TOO HOT!', px + pw / 2, py + ph / 2 + 5);
        }
      },
    },
    nuts: {
      draw(c, g, x, y, w, h) {
        const cx = x + w / 2,
          cy = y + h / 2 + 2,
          R = Math.min(w, h) * 0.36;
        if (g.panel) {
          c.fillStyle = '#22262b';
          roundRect(c, cx - R - 12, cy - R - 8, R * 2 + 24, R * 2 + 16, 6);
          c.fill();
          c.fillStyle = '#8e939b';
          roundRect(c, cx - R * 0.65, cy - R, R * 1.3, R * 2, 4);
          c.fill();
          c.fillStyle = '#555c64';
          c.fillRect(cx - R * 0.2, cy - R, R * 0.4, R * 2);
        } else {
          c.fillStyle = '#1b1b1f';
          c.beginPath();
          c.arc(cx, cy, R + 12, 0, TAU);
          c.fill();
          c.fillStyle = '#8e939b';
          c.beginPath();
          c.arc(cx, cy, R - 6, 0, TAU);
          c.fill();
        }
        g.seq.forEach((d, i) => {
          const a = -Math.PI / 2 + (i / g.seq.length) * TAU,
            nx = cx + Math.cos(a) * R * 0.62,
            ny = cy + Math.sin(a) * R * 0.62;
          if (i < g.i) {
            c.fillStyle = g.panel ? '#63e08b' : '#3b3e44';
            c.beginPath();
            c.arc(nx, ny, 5, 0, TAU);
            c.fill();
            return;
          }
          c.fillStyle = i === g.i ? (g.bad > 0 ? '#ff5468' : '#ffc24b') : '#c8cdd4';
          c.beginPath();
          c.arc(nx, ny, i === g.i ? 15 : 10, 0, TAU);
          c.fill();
          drawArrow(c, nx, ny, d, i === g.i ? 9 : 6, '#1a1620');
        });
        if (g.i >= g.seq.length) {
          c.fillStyle = '#ffc24b';
          c.font = 'bold 20px "Barlow Condensed", sans-serif';
          c.textAlign = 'center';
          c.fillText(`${'●'.repeat(g.mash)}${'○'.repeat(Math.max(0, g.taps - g.mash))}`, cx, cy + 7);
        }
      },
    },
    hammer: {
      draw(c, g, x, y, w, h) {
        const bx = x + 14,
          bw = w - 28,
          by = y + h / 2 - 12;
        c.fillStyle = '#1b1822';
        c.fillRect(bx, by, bw, 24);
        c.fillStyle = g.flash > 0 ? '#b6ffcb' : 'rgba(99,224,139,0.7)';
        c.fillRect(bx + bw * (g.zone - g.w / 2), by, bw * g.w, 24);
        c.fillStyle = g.miss > 0 ? '#ff5468' : '#fff3df';
        c.fillRect(bx + bw * g.x - 2, by - 8, 4, 40);
        c.fillStyle = '#ffc24b';
        c.font = 'bold 18px "Barlow Condensed", sans-serif';
        c.textAlign = 'center';
        c.fillText(`${'●'.repeat(g.hits)}${'○'.repeat(g.need - g.hits)}`, x + w / 2, by + 52);
      },
    },
    dial: {
      draw(c, g, x, y, w, h) {
        const cx = x + w / 2,
          cy = y + h - 16,
          R = Math.min(w * 0.42, h - 28);
        const ang = (v: number) => Math.PI + ((v + 1) / 2) * Math.PI;
        c.lineWidth = 14;
        c.strokeStyle = '#1b1822';
        c.beginPath();
        c.arc(cx, cy, R, Math.PI, TAU);
        c.stroke();
        c.strokeStyle = 'rgba(99,224,139,0.8)';
        c.beginPath();
        c.arc(cx, cy, R, ang(g.target - g.w / 2), ang(g.target + g.w / 2));
        c.stroke();
        c.lineWidth = 4;
        c.strokeStyle = g.in ? '#b6ffcb' : '#ffc24b';
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(ang(g.a)) * (R - 4), cy + Math.sin(ang(g.a)) * (R - 4));
        c.stroke();
        c.fillStyle = '#fff3df';
        c.beginPath();
        c.arc(cx, cy, 6, 0, TAU);
        c.fill();
      },
    },
    spray: {
      draw(c, g, x, y, w, h) {
        // the engine bay under the open hood
        c.fillStyle = '#23262b';
        roundRect(c, x, y + h * 0.2, w, h * 0.6, 8);
        c.fill();
        c.fillStyle = '#3a3f47';
        roundRect(c, x + w * 0.22, y + h * 0.4, w * 0.56, h * 0.28, 6);
        c.fill();
        c.fillStyle = '#4a5059';
        for (let i = 0; i < 4; i++) c.fillRect(x + w * (0.27 + i * 0.12), y + h * 0.33, w * 0.07, h * 0.08);
        const t = performance.now() / 1000;
        for (const f of g.flames) {
          const fx = x + f.x * w,
            fy = y + f.y * h;
          if (f.hp <= 0) {
            c.fillStyle = 'rgba(225,225,225,0.3)';
            c.beginPath();
            c.arc(fx, fy - 8 - ((t * 18 + f.x * 40) % 14), 5, 0, TAU);
            c.fill();
            continue;
          }
          drawFlame(c, fx, fy, 6 + f.hp * 11, t + f.x * 7);
          c.fillStyle = 'rgba(255,110,30,0.65)';
          c.fillRect(fx - 7, fy + 3, 14, 2); // where it burns from
        }
        // the extinguisher: a red bottle with a gauge, a hose to the nozzle you aim
        const bx = x + 6,
          by = y + h - 2,
          ax = x + g.cx * w,
          ay = y + g.cy * h;
        c.strokeStyle = '#141418';
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(bx + 9, by - 50);
        c.quadraticCurveTo(bx + 34, by - 64, ax, ay + 18);
        c.stroke();
        c.fillStyle = '#c62a22';
        roundRect(c, bx, by - 46, 18, 46, 6);
        c.fill();
        c.fillStyle = '#e8e4da';
        c.fillRect(bx + 2, by - 24, 14, 9); // label
        c.fillStyle = '#141418';
        c.fillRect(bx + 4, by - 53, 10, 8);
        const gx = bx + 9,
          gy = by - 36,
          an = Math.PI * (0.8 + 1.4 * (1 - g.pressure));
        c.fillStyle = '#f2f2ee';
        c.beginPath();
        c.arc(gx, gy, 5.5, 0, TAU);
        c.fill();
        c.strokeStyle = g.pressure > 0.3 ? '#2f9e44' : '#ff5468';
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(gx, gy);
        c.lineTo(gx + Math.cos(an) * 4.5, gy + Math.sin(an) * 4.5);
        c.stroke();
        if (g.spraying) {
          // the powder cloud
          for (let i = 0; i < 16; i++) {
            const k = Math.random();
            c.fillStyle = `rgba(240,246,255,${0.3 + 0.45 * k})`;
            c.beginPath();
            c.arc(ax + rand(-11, 11) * k, ay + 16 - k * 16 + rand(-9, 9) * k, 2 + k * 6, 0, TAU);
            c.fill();
          }
        }
        c.fillStyle = '#141418';
        c.fillRect(ax - 3, ay + 10, 6, 10); // nozzle
        c.strokeStyle = '#fff';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(ax, ay, 9, 0, TAU);
        c.moveTo(ax - 13, ay);
        c.lineTo(ax + 13, ay);
        c.moveTo(ax, ay - 13);
        c.lineTo(ax, ay + 13);
        c.stroke();
        // pressure, down the right-hand side
        c.fillStyle = '#1b1822';
        c.fillRect(x + w - 9, y + h * 0.2, 6, h * 0.6);
        c.fillStyle = g.empty ? '#ff5468' : '#7ad1ff';
        c.fillRect(x + w - 9, y + h * 0.2 + h * 0.6 * (1 - g.pressure), 6, h * 0.6 * g.pressure);
        if (g.empty) {
          c.fillStyle = '#ff5468';
          c.font = `700 12px ${UI_FONT}`;
          c.textAlign = 'center';
          c.fillText('EMPTY · LET THE PRESSURE BUILD', x + w / 2, y + h * 0.13, w);
        }
      },
    },
    pour: {
      draw(c, g, x, y, w, h, car) {
        if (!car) throw new Error('Pouring requires a car');
        const fuel = car.sys.fuel;
        const tx = x + w * 0.6,
          ty = y + 10,
          tw = 46,
          th = h - 22;
        c.fillStyle = '#1b1822';
        c.fillRect(tx, ty, tw, th);
        c.fillStyle = 'rgba(99,224,139,0.35)';
        c.fillRect(tx, ty, tw, th * 0.12);
        c.fillStyle = g.spill > 0 ? '#ff5468' : '#ffc24b';
        c.fillRect(tx + 4, ty + th * (1 - fuel / 100), tw - 8, th * (fuel / 100));
        c.strokeStyle = '#fff3df';
        c.lineWidth = 2;
        c.strokeRect(tx, ty, tw, th);
        // jerrycan
        c.save();
        c.translate(x + w * 0.3, y + h * 0.45);
        c.rotate(g.pouring ? -0.9 : -0.2);
        c.fillStyle = '#c0392b';
        roundRect(c, -24, -30, 48, 60, 6);
        c.fill();
        c.fillStyle = '#7f2219';
        c.fillRect(-6, -40, 12, 12);
        c.fillStyle = 'rgba(255,194,75,0.85)';
        c.fillRect(-18, 24 - 48 * (g.can / canFuel()), 36, 48 * (g.can / canFuel())); // what's left in the can
        c.restore();
        if (g.spill > 0) {
          c.fillStyle = '#ff5468';
          c.font = 'bold 18px "Barlow Condensed", sans-serif';
          c.textAlign = 'center';
          c.fillText('SPILLED!', x + w * 0.3, y + h - 8);
        }
      },
    },
    dents: {
      draw(c, g, x, y, w, h) {
        const cx = x + w / 2,
          cy = y + h / 2;
        c.save();
        c.translate(cx + (g.bump > 0 ? rand(-3, 3) : 0), cy);
        c.fillStyle = '#6a6f77';
        roundRect(c, -60, -32, 120, 64, 8);
        c.fill();
        c.fillStyle = 'rgba(0,0,0,0.35)';
        for (let i = 0; i < Math.ceil((1 - g.prog) * 5); i++) {
          c.beginPath();
          c.ellipse(-40 + i * 20, i % 2 ? 8 : -8, 9, 6, 0, 0, TAU);
          c.fill();
        }
        c.restore();
        drawArrow(c, cx - 90, cy, 'left', 14, g.next === 'left' ? '#ffc24b' : '#4a4458');
        drawArrow(c, cx + 90, cy, 'right', 14, g.next === 'right' ? '#ffc24b' : '#4a4458');
      },
    },
    radar: {
      draw(c, g, x, y, w, h) {
        const cx = x + w / 2,
          cy = y + h / 2,
          R = Math.min(w, h) * 0.46;
        c.fillStyle = '#021a0b';
        c.beginPath();
        c.arc(cx, cy, R, 0, TAU);
        c.fill();
        c.strokeStyle = 'rgba(90,255,150,0.3)';
        c.lineWidth = 1;
        c.beginPath();
        c.arc(cx, cy, R * 0.5, 0, TAU);
        c.stroke();
        if (c.createConicGradient) {
          const cg = c.createConicGradient(g.a, cx, cy);
          cg.addColorStop(0, 'rgba(90,255,150,0.5)');
          cg.addColorStop(0.2, 'rgba(90,255,150,0)');
          cg.addColorStop(1, 'rgba(90,255,150,0)');
          c.fillStyle = cg;
          c.beginPath();
          c.arc(cx, cy, R, 0, TAU);
          c.fill();
        }
        const bx = cx + Math.cos(g.blip) * R * 0.7,
          by = cy + Math.sin(g.blip) * R * 0.7;
        c.fillStyle = g.flash > 0 ? '#ffffff' : '#ff5a4f';
        c.beginPath();
        c.arc(bx, by, 5, 0, TAU);
        c.fill();
        c.strokeStyle = g.miss > 0 ? '#ff5468' : '#a8ffca';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(g.a) * R, cy + Math.sin(g.a) * R);
        c.stroke();
        c.strokeStyle = '#0c0f0d';
        c.lineWidth = 3;
        c.beginPath();
        c.arc(cx, cy, R, 0, TAU);
        c.stroke();
        c.fillStyle = '#ffc24b';
        c.font = 'bold 16px "Barlow Condensed", sans-serif';
        c.textAlign = 'left';
        c.fillText(`${'●'.repeat(g.hits)}${'○'.repeat(g.need - g.hits)}`, x + 4, y + h - 4);
      },
    },
    glass: {
      draw(c, g, x, y, w, h) {
        const cx = x + w / 2,
          cy = y + h / 2,
          pw = w * 0.62,
          ph = h * 0.62;
        c.strokeStyle = '#2b2d31';
        c.lineWidth = 6;
        c.strokeRect(cx - pw / 2, cy - ph / 2, pw, ph); // the frame
        if (g.phase === 0) {
          const shake = g.flash > 0 ? rand(-3, 3) : 0;
          c.fillStyle = 'rgba(160,200,220,0.35)';
          c.fillRect(
            cx - pw / 2 + shake,
            cy - ph / 2,
            pw,
            ph * Math.max(0, 1 - g.knocks / rules.glass.knocks),
          );
          c.strokeStyle = 'rgba(236,244,250,0.9)';
          c.lineWidth = 1.2;
          for (let i = 0; i < 9; i++) {
            const a = i * 0.7;
            c.beginPath();
            c.moveTo(cx + shake, cy);
            c.lineTo(cx + shake + Math.cos(a) * pw * 0.45, cy + Math.sin(a) * ph * 0.45);
            c.stroke();
          }
        } else {
          c.fillStyle =
            g.flash > 0
              ? 'rgba(182,255,203,0.6)'
              : g.miss > 0
                ? 'rgba(255,84,104,0.45)'
                : 'rgba(160,210,235,0.55)';
          c.fillRect(cx - pw / 2 + g.x * w * 0.3, cy - ph / 2 + 4, pw, ph - 8);
          c.fillStyle = '#ffc24b';
          c.font = 'bold 18px "Barlow Condensed", sans-serif';
          c.textAlign = 'center';
          c.fillText(
            `${'●'.repeat(g.hits)}${'○'.repeat(Math.max(0, rules.glass.hits - g.hits))}`,
            cx,
            y + h - 2,
          );
        }
      },
    },
    unjam: {
      draw(c, g, x, y, w, h) {
        // the gun's breech with the stuck shell, then the arrow sequence
        const bx = x + w / 2 - 70 + (g.kick > 0 ? rand(-3, 3) : 0),
          by = y + 6;
        c.fillStyle = '#2b2d31';
        roundRect(c, bx, by, 140, 30, 6);
        c.fill();
        c.fillStyle = '#17181b';
        c.fillRect(bx + 140, by + 10, 40, 10);
        c.fillStyle = '#c99a2e';
        c.fillRect(bx + 56 + g.prog * 60, by + 9, 22, 12);
        g.seq.forEach((d, i) => {
          const cx = x + w / 2 + (i - 1.5) * 44,
            cy = y + h - 22;
          c.fillStyle = i < g.i ? '#3b3e44' : i === g.i ? (g.bad > 0 ? '#ff5468' : '#ffc24b') : '#c8cdd4';
          roundRect(c, cx - 17, cy - 17, 34, 34, 7);
          c.fill();
          if (i >= g.i) drawArrow(c, cx, cy, d, i === g.i ? 11 : 8, '#1a1620');
        });
      },
    },
  };
}
export function drawMiniGame<C extends MiniCar>(
  views: GameViews<C>,
  game: ActiveGame,
  context: Context,
  x: number,
  y: number,
  width: number,
  height: number,
  car: C,
): void {
  switch (game.type) {
    case 'glue':
      views.glue.draw(context, game, x, y, width, height, car);
      break;
    case 'nuts':
      views.nuts.draw(context, game, x, y, width, height, car);
      break;
    case 'hammer':
      views.hammer.draw(context, game, x, y, width, height, car);
      break;
    case 'dial':
      views.dial.draw(context, game, x, y, width, height, car);
      break;
    case 'spray':
      views.spray.draw(context, game, x, y, width, height, car);
      break;
    case 'pour':
      views.pour.draw(context, game, x, y, width, height, car);
      break;
    case 'dents':
      views.dents.draw(context, game, x, y, width, height, car);
      break;
    case 'radar':
      views.radar.draw(context, game, x, y, width, height, car);
      break;
    case 'glass':
      views.glass.draw(context, game, x, y, width, height, car);
      break;
    case 'unjam':
      views.unjam.draw(context, game, x, y, width, height, car);
      break;
    default: {
      const exhaustive: never = game;
      throw new Error(`Unknown minigame: ${exhaustive}`);
    }
  }
}
