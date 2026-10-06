import type { Stick } from "./input";

export interface Arrow {
  x: number;
  y: number;
  angle: number;
  color: string;
  size: number;
  alpha: number;
}

export interface OverlayFrame {
  w: number;
  h: number;
  showCrosshair: boolean;
  cross: { x: number; y: number };
  accent: string;
  /** 0..1 dash readiness */
  dashReady: number;
  /** screen position of the aim-assisted target, if any */
  lockOn: { x: number; y: number } | null;
  hint: string | null;
  autoFire: boolean;
  touch: boolean;
  stick: Stick | null;
  dashButton: { x: number; y: number; r: number };
  arrows: readonly Arrow[];
  arrowCount: number;
}

/** 2D canvas over the WebGL canvas: crosshair, threat arrows, hints, touch controls. */
export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private dpr = 1;
  private cw = 0;
  private ch = 0;
  private dirty = true;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "1" });
    this.canvas.setAttribute("aria-hidden", "true");
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = Math.min(2, dpr || 1);
    const W = Math.max(1, Math.round(w * this.dpr));
    const H = Math.max(1, Math.round(h * this.dpr));
    if (W !== this.cw || H !== this.ch) {
      this.canvas.width = this.cw = W;
      this.canvas.height = this.ch = H;
    }
  }

  draw(f: OverlayFrame) {
    const g = this.ctx;
    if (!g) return;
    const nothing = !f.showCrosshair && !f.hint && !f.touch && f.arrowCount === 0;
    if (nothing && !this.dirty) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, f.w, f.h);
    this.dirty = !nothing;

    // threat arrows
    for (let i = 0; i < f.arrowCount; i++) {
      const a = f.arrows[i]!;
      g.save();
      g.translate(a.x, a.y);
      g.rotate(a.angle);
      g.globalAlpha = a.alpha;
      const s = a.size;
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, s * 2.2);
      grad.addColorStop(0, a.color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.globalAlpha = a.alpha * 0.35;
      g.beginPath();
      g.arc(0, 0, s * 2.2, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = a.alpha;
      g.fillStyle = a.color;
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(s, 0);
      g.lineTo(-s * 0.7, s * 0.7);
      g.lineTo(-s * 0.35, 0);
      g.lineTo(-s * 0.7, -s * 0.7);
      g.closePath();
      g.stroke();
      g.fill();
      g.restore();
    }

    if (f.showCrosshair) {
      const { x, y } = f.cross;
      g.save();
      g.strokeStyle = f.accent;
      g.lineWidth = 2;
      g.shadowColor = f.accent;
      g.shadowBlur = 8;
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.moveTo(x - 20, y);
      g.lineTo(x - 13, y);
      g.moveTo(x + 13, y);
      g.lineTo(x + 20, y);
      g.moveTo(x, y - 20);
      g.lineTo(x, y - 13);
      g.moveTo(x, y + 13);
      g.lineTo(x, y + 20);
      g.stroke();
      // dash readiness arc
      g.shadowBlur = 0;
      g.globalAlpha = 0.55;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, f.dashReady)));
      g.stroke();
      if (f.autoFire) {
        g.globalAlpha = 0.8;
        g.fillStyle = f.accent;
        g.font = "600 10px ui-monospace, Menlo, monospace";
        g.textAlign = "center";
        g.fillText("AUTO", x, y + 42);
      }
      if (f.lockOn) {
        const l = f.lockOn;
        g.globalAlpha = 0.85;
        g.lineWidth = 2;
        const r = 16;
        g.beginPath();
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          g.moveTo(l.x + sx * r, l.y + sy * (r - 7));
          g.lineTo(l.x + sx * r, l.y + sy * r);
          g.lineTo(l.x + sx * (r - 7), l.y + sy * r);
        }
        g.stroke();
      }
      g.restore();
    }

    if (f.hint) {
      g.save();
      g.font = "600 14px ui-sans-serif, system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      const tw = g.measureText(f.hint).width + 32;
      const x = f.w / 2;
      const y = f.h - 36;
      g.fillStyle = "rgba(5,5,12,0.62)";
      g.strokeStyle = f.accent;
      g.globalAlpha = 0.95;
      g.lineWidth = 1;
      const r = 16;
      g.beginPath();
      g.roundRect?.(x - tw / 2, y - r, tw, r * 2, r);
      g.fill();
      g.stroke();
      g.fillStyle = "#fff";
      g.fillText(f.hint, x, y + 1);
      g.restore();
    }

    if (f.touch) {
      g.save();
      const st = f.stick;
      if (st) {
        const dx = st.x - st.ox;
        const dy = st.y - st.oy;
        const l = Math.hypot(dx, dy);
        const m = Math.min(l, 60);
        const k = l > 0 ? m / l : 0;
        g.fillStyle = "rgba(255,255,255,0.08)";
        g.strokeStyle = "rgba(255,255,255,0.3)";
        g.lineWidth = 2;
        g.beginPath();
        g.arc(st.ox, st.oy, 60, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = f.accent;
        g.globalAlpha = 0.6;
        g.beginPath();
        g.arc(st.ox + dx * k, st.oy + dy * k, 24, 0, Math.PI * 2);
        g.fill();
      }
      const d = f.dashButton;
      g.globalAlpha = 0.4 + 0.5 * (f.dashReady >= 1 ? 1 : 0);
      g.strokeStyle = f.accent;
      g.fillStyle = "rgba(5,5,12,0.35)";
      g.lineWidth = 3;
      g.beginPath();
      g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.arc(d.x, d.y, d.r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, f.dashReady)));
      g.stroke();
      g.fillStyle = "#fff";
      g.font = "700 13px ui-sans-serif, system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("DASH", d.x, d.y);
      g.restore();
    }
  }

  dispose() {
    this.canvas.remove();
  }
}
