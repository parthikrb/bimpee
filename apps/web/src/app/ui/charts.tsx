import { useId } from "react";
import type { WorldSpec } from "@bimpee/shared";
import type { PacingSample } from "../store/run";

/** Live intensity vs target sparkline for the director HUD (last ~90s). */
export function Sparkline({ samples, windowSec = 90, height = 64 }: { samples: PacingSample[]; windowSec?: number; height?: number }) {
  const gid = useId();
  const W = 240;
  const H = height;
  if (samples.length < 2) {
    return (
      <div className="grid place-items-center text-[10px] font-mono text-muted" style={{ height }}>
        waiting for pacing data…
      </div>
    );
  }
  const tMax = samples[samples.length - 1]!.t;
  const tMin = tMax - windowSec;
  const x = (t: number) => ((t - tMin) / windowSec) * W;
  const y = (v: number) => H - 3 - v * (H - 6);
  const line = (key: "intensity" | "target") =>
    samples.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const intensity = line("intensity");
  const area = `${intensity} L${x(tMax).toFixed(1)},${H} L${x(samples[0]!.t).toFixed(1)},${H} Z`;
  const last = samples[samples.length - 1]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height }} role="img" aria-label={`Intensity ${Math.round(last.intensity * 100)}%, target ${Math.round(last.target * 100)}%`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--world-accent)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--world-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={W} y1={y(g)} y2={y(g)} stroke="white" strokeOpacity="0.07" strokeWidth="1" />
      ))}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line("target")} fill="none" stroke="var(--neon-pink)" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      <path d={intensity} fill="none" stroke="var(--world-accent)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last.t)} cy={y(last.intensity)} r="3" fill="var(--world-accent)" />
    </svg>
  );
}

/** Whole-run intensity curve (RunReport.intensityCurve, ~5s per sample) with act bands. */
export function IntensityChart({ curve, world, sampleSec = 5 }: { curve: number[]; world: WorldSpec; sampleSec?: number }) {
  const gid = useId();
  const W = 600;
  const H = 160;
  const PAD_B = 18;
  if (curve.length < 2) {
    return <div className="grid h-40 place-items-center text-sm text-muted">Not enough data for a curve. Next time, survive longer?</div>;
  }
  const total = (curve.length - 1) * sampleSec;
  const x = (t: number) => (t / total) * W;
  const y = (v: number) => H - PAD_B - v * (H - PAD_B - 8);
  const pts = curve.map((v, i) => `${i ? "L" : "M"}${x(i * sampleSec).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${pts} L${W},${H - PAD_B} L0,${H - PAD_B} Z`;
  let acc = 0;
  const acts = world.arc.map((a, i) => {
    const start = acc;
    acc += a.durationSec;
    return { i, name: a.name, start, end: acc, target: a.intensityTarget };
  });
  const peak = curve.reduce((m, v, i) => (v > curve[m]! ? i : m), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Intensity over the run, peaking at ${Math.round(curve[peak]! * 100)}%`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--world-glow)" stopOpacity="0.6" />
          <stop offset="1" stopColor="var(--world-accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {acts.map((a) =>
        a.start < total ? (
          <g key={a.i}>
            <rect x={x(a.start)} y={0} width={Math.max(0, x(Math.min(a.end, total)) - x(a.start))} height={H - PAD_B} fill="white" opacity={a.i % 2 ? 0.035 : 0} />
            <line x1={x(a.start)} x2={x(Math.min(a.end, total))} y1={y(a.target)} y2={y(a.target)} stroke="var(--neon-pink)" strokeDasharray="5 4" strokeOpacity="0.7" />
            <text x={x(a.start) + 6} y={H - 5} fill="var(--muted)" fontSize="10" fontFamily="var(--font-mono)">
              {a.name.length > 22 ? `${a.name.slice(0, 21)}…` : a.name}
            </text>
          </g>
        ) : null,
      )}
      <path d={area} fill={`url(#${gid})`} />
      <path d={pts} fill="none" stroke="var(--world-accent)" strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx={x(peak * sampleSec)} cy={y(curve[peak]!)} r="4.5" fill="var(--neon-sun)" stroke="var(--ink)" strokeWidth="2" />
      <text x={Math.min(W - 60, x(peak * sampleSec) + 8)} y={Math.max(12, y(curve[peak]!) - 6)} fill="var(--neon-sun)" fontSize="10" fontFamily="var(--font-mono)">
        peak {Math.round(curve[peak]! * 100)}%
      </text>
    </svg>
  );
}
