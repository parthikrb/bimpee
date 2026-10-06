/** Pure input math for the chase camera (no three, no DOM). */

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Converts stick/WASD input into a sim-plane move vector relative to the
 * camera. `ix` is right(+)/left(-), `iy` uses the screen convention where
 * up/forward is -1. `yaw` is the sim angle the camera looks along.
 * Output length is clamped to 1.
 */
export function cameraRelativeMove(ix: number, iy: number, yaw: number, out: Vec2): Vec2 {
  const fwd = Number.isFinite(iy) ? -iy : 0;
  const str = Number.isFinite(ix) ? ix : 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let x = fwd * c - str * s;
  let y = fwd * s + str * c;
  const l = Math.hypot(x, y);
  if (l > 1) {
    x /= l;
    y /= l;
  }
  out.x = Math.abs(x) < 1e-9 ? 0 : x;
  out.y = Math.abs(y) < 1e-9 ? 0 : y;
  return out;
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

/** Exponential smoothing factor for a rate (1/s) over dt, frame-rate independent. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * Math.max(0, dt));

/**
 * Critically damped spring step (Game Programming Gems 4). Mutates `state`
 * ({ x: value, v: velocity }) towards `target` with angular frequency `omega`.
 */
export function springStep(state: { x: number; v: number }, target: number, omega: number, dt: number) {
  if (!Number.isFinite(target)) return;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = state.x - target;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  state.x = target + (change + temp) * exp;
  if (!Number.isFinite(state.x) || !Number.isFinite(state.v)) {
    state.x = target;
    state.v = 0;
  }
}
