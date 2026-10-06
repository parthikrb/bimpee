/**
 * Keyboard + mouse (pointer lock) + touch for the chase camera.
 * Produces raw intents each frame; the camera rig and GameView turn them
 * into yaw/pitch changes and a SimInput.
 */

const STICK_RADIUS = 60;
const MOUSE_SENS = 0.0024;
const AUTO_AIM_AFTER_MS = 2000;

export interface Intents {
  /** -1..1 screen convention (up = -1) */
  moveX: number;
  moveY: number;
  dash: boolean;
  firing: boolean;
  /** radians to add to camera yaw / pitch this frame */
  yaw: number;
  pitch: number;
  locked: boolean;
  touch: boolean;
  /** cursor-driven aim (unlocked desktop): css px within the element, else null */
  cursor: { x: number; y: number } | null;
  autoFire: boolean;
}

export interface Stick {
  id: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
}

const typing = () => {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
};

export class InputController {
  private readonly keys = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private yawAcc = 0;
  private pitchAcc = 0;
  private dashQueued = false;
  private dashHeld = false;
  private mouseDown = false;
  private mouseX = 0;
  private mouseY = 0;
  private lastMouse = -1e9;
  locked = false;
  touchMode = false;
  autoFire = false;
  stick: Stick | null = null;
  private look: { id: number; x: number } | null = null;
  /** dash button centre (css px), set by the overlay layout */
  dashButton = { x: -1000, y: -1000, r: 46 };
  private destroyed = false;
  private readonly cur = { x: 0, y: 0 };

  constructor(
    private readonly el: HTMLElement,
    private readonly canLock: () => boolean,
  ) {
    const on = <K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const onEl = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    if (typeof window !== "undefined") {
      if (window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches) this.touchMode = true;
      on(window, "keydown", (e) => {
        if (typing()) return;
        this.keys.add(e.code);
        if (e.code === "KeyF" && !e.repeat) this.autoFire = !this.autoFire;
        if (e.code === "Space" && (e.target === document.body || e.target === el || el.contains(e.target as Node))) e.preventDefault();
      });
      on(window, "keyup", (e) => this.keys.delete(e.code));
      on(window, "blur", () => this.reset());
      const onVis = () => {
        if (document.visibilityState === "hidden") this.reset();
      };
      document.addEventListener("visibilitychange", onVis);
      this.offs.push(() => document.removeEventListener("visibilitychange", onVis));
      const onLockChange = () => {
        this.locked = document.pointerLockElement === el;
        if (!this.locked) this.mouseDown = false;
      };
      document.addEventListener("pointerlockchange", onLockChange);
      this.offs.push(() => document.removeEventListener("pointerlockchange", onLockChange));
      const onLockErr = () => (this.locked = false);
      document.addEventListener("pointerlockerror", onLockErr);
      this.offs.push(() => document.removeEventListener("pointerlockerror", onLockErr));
      const onMouseMove = (e: MouseEvent) => {
        if (!this.locked) return;
        const mx = Math.max(-300, Math.min(300, e.movementX || 0));
        const my = Math.max(-300, Math.min(300, e.movementY || 0));
        this.yawAcc += mx * MOUSE_SENS;
        this.pitchAcc += my * MOUSE_SENS;
      };
      document.addEventListener("mousemove", onMouseMove);
      this.offs.push(() => document.removeEventListener("mousemove", onMouseMove));
      on(window, "pointerup", (e) => {
        if (e.pointerType === "mouse" && e.button === 0) this.mouseDown = false;
      });
    }
    onEl("contextmenu", (e) => e.preventDefault());
    onEl("pointerdown", (e) => {
      if (e.pointerType === "touch") {
        this.touchMode = true;
        this.touchDown(e);
        return;
      }
      this.touchMode = false;
      const r = el.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
      this.lastMouse = performance.now();
      if (e.button === 0) {
        this.mouseDown = true;
        if (!this.locked && this.canLock()) this.requestLock();
      }
    });
    onEl("pointermove", (e) => {
      if (e.pointerType === "touch") {
        this.touchMove(e);
        return;
      }
      if (this.locked) return;
      this.touchMode = false;
      const r = el.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
      this.lastMouse = performance.now();
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (this.stick && e.pointerId === this.stick.id) this.stick = null;
      if (this.look && e.pointerId === this.look.id) this.look = null;
    };
    onEl("pointerup", up);
    onEl("pointercancel", up);
  }

  private touchDown(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const db = this.dashButton;
    if (Math.hypot(x - db.x, y - db.y) <= db.r + 10) {
      this.dashQueued = true;
      return;
    }
    if (x < r.width / 2) {
      if (!this.stick) this.stick = { id: e.pointerId, ox: x, oy: y, x, y };
      return;
    }
    if (this.look) {
      // a second finger on the right half while looking = dash
      this.dashQueued = true;
      return;
    }
    this.look = { id: e.pointerId, x };
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private touchMove(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick.x = x;
      this.stick.y = y;
    } else if (this.look && e.pointerId === this.look.id) {
      this.yawAcc += (x - this.look.x) * 0.006;
      this.look.x = x;
    }
  }

  requestLock() {
    const el = this.el as HTMLElement & { requestPointerLock?: () => unknown };
    if (this.destroyed || !el.requestPointerLock) return;
    try {
      const r = el.requestPointerLock();
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => (this.locked = false));
    } catch {
      this.locked = false;
    }
  }

  releaseLock() {
    this.mouseDown = false;
    if (typeof document !== "undefined" && document.pointerLockElement === this.el) {
      try {
        document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
    this.locked = false;
  }

  private reset() {
    this.keys.clear();
    this.mouseDown = false;
    this.stick = null;
    this.look = null;
    this.dashHeld = false;
  }

  /** Reads and clears this frame's accumulated intents. */
  consume(dt: number, out: Intents): Intents {
    const k = this.keys;
    let mx = 0;
    let my = 0;
    let rot = 0;
    if (!typing()) {
      if (k.has("KeyA") || k.has("ArrowLeft")) mx -= 1;
      if (k.has("KeyD") || k.has("ArrowRight")) mx += 1;
      if (k.has("KeyW") || k.has("ArrowUp")) my -= 1;
      if (k.has("KeyS") || k.has("ArrowDown")) my += 1;
      if (k.has("KeyQ")) rot -= 1;
      if (k.has("KeyE")) rot += 1;
    }
    const held = k.has("Space") || k.has("ShiftLeft") || k.has("ShiftRight");
    let dash = held && !this.dashHeld;
    this.dashHeld = held;
    if (this.dashQueued) {
      dash = true;
      this.dashQueued = false;
    }
    if (this.stick) {
      const dx = this.stick.x - this.stick.ox;
      const dy = this.stick.y - this.stick.oy;
      const l = Math.hypot(dx, dy);
      if (l > 8) {
        const m = Math.min(1, l / STICK_RADIUS);
        mx = (dx / l) * m;
        my = (dy / l) * m;
      }
    }
    // Q/E rotate when the mouse isn't steering the camera
    if (!this.locked && rot) this.yawAcc += rot * 2.2 * dt;
    out.moveX = mx;
    out.moveY = my;
    out.dash = dash;
    out.yaw = this.yawAcc;
    out.pitch = this.pitchAcc;
    this.yawAcc = 0;
    this.pitchAcc = 0;
    out.locked = this.locked;
    out.touch = this.touchMode;
    out.autoFire = this.autoFire;
    const recent = performance.now() - this.lastMouse < AUTO_AIM_AFTER_MS;
    this.cur.x = this.mouseX;
    this.cur.y = this.mouseY;
    out.cursor = !this.touchMode && !this.locked && (recent || this.mouseDown) ? this.cur : null;
    out.firing = !this.touchMode && (this.mouseDown || this.autoFire);
    return out;
  }

  destroy() {
    if (this.destroyed) return;
    this.releaseLock();
    this.destroyed = true;
    for (const f of this.offs) f();
    this.offs.length = 0;
    this.reset();
  }
}
