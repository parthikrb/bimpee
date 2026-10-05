import type * as Phaser from "phaser";
import type { SimInput } from "../sim/types";

const AUTO_AIM_AFTER_MS = 2000;
const STICK_RADIUS = 60;

type KeyMap = Record<"W" | "A" | "S" | "D" | "UP" | "DOWN" | "LEFT" | "RIGHT" | "SPACE" | "SHIFT", Phaser.Input.Keyboard.Key>;

/**
 * Keyboard + mouse + touch -> SimInput.
 *  - WASD/arrows move, Space/Shift dash
 *  - mouse aims, hold to fire; no mouse movement for 2s => auto-aim/auto-fire
 *  - touch: left half is a virtual joystick, tap right half to dash, always auto-fire
 */
export class InputSystem {
  private keys: KeyMap | null = null;
  private lastMouseMove = -1e9;
  private mouseX = 0;
  private mouseY = 0;
  touchMode = false;
  /** joystick state, screen coordinates */
  stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private dashQueued = false;
  private dashHeld = false;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly scene: Phaser.Scene) {
    const kb = scene.input.keyboard;
    if (kb) {
      // enableCapture=false: never swallow keys meant for the React shell (chat, forms).
      this.keys = kb.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,SHIFT", false) as KeyMap;
    }
    scene.input.addPointer(2);
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches) {
      this.touchMode = true;
    }
    const onMove = (p: Phaser.Input.Pointer) => {
      if (p.wasTouch) {
        this.touchMode = true;
        if (this.stick && p.id === this.stick.id) {
          this.stick.x = p.x;
          this.stick.y = p.y;
        }
        return;
      }
      this.touchMode = false;
      this.lastMouseMove = scene.time.now;
      this.mouseX = p.x;
      this.mouseY = p.y;
    };
    const onDown = (p: Phaser.Input.Pointer) => {
      if (p.wasTouch) {
        this.touchMode = true;
        if (p.x < scene.scale.width / 2) {
          if (!this.stick) this.stick = { id: p.id, ox: p.x, oy: p.y, x: p.x, y: p.y };
        } else this.dashQueued = true;
        return;
      }
      this.touchMode = false;
      this.lastMouseMove = scene.time.now;
      this.mouseX = p.x;
      this.mouseY = p.y;
    };
    const onUp = (p: Phaser.Input.Pointer) => {
      if (this.stick && p.id === this.stick.id) this.stick = null;
    };
    scene.input.on("pointermove", onMove);
    scene.input.on("pointerdown", onDown);
    scene.input.on("pointerup", onUp);
    scene.input.on("pointerupoutside", onUp);
    this.offs.push(() => {
      scene.input.off("pointermove", onMove);
      scene.input.off("pointerdown", onDown);
      scene.input.off("pointerup", onUp);
      scene.input.off("pointerupoutside", onUp);
    });
  }

  private typingInShell(): boolean {
    if (typeof document === "undefined") return false;
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  /**
   * @param center world point at the screen centre, @param zoom camera zoom,
   * @param player world position of the player (aim origin)
   */
  read(center: { x: number; y: number }, zoom: number, player: { x: number; y: number }, viewW: number, viewH: number): SimInput {
    let mx = 0;
    let my = 0;
    let dash = false;
    const k = this.keys;
    if (k && !this.typingInShell()) {
      if (k.A.isDown || k.LEFT.isDown) mx -= 1;
      if (k.D.isDown || k.RIGHT.isDown) mx += 1;
      if (k.W.isDown || k.UP.isDown) my -= 1;
      if (k.S.isDown || k.DOWN.isDown) my += 1;
      const held = k.SPACE.isDown || k.SHIFT.isDown;
      if (held && !this.dashHeld) dash = true;
      this.dashHeld = held;
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
    if (this.dashQueued) {
      dash = true;
      this.dashQueued = false;
    }

    let aim: number | null = null;
    let aimDist = 300;
    let firing = false;
    const ap = this.scene.input.activePointer;
    const mouseDown = !this.touchMode && ap.isDown && !ap.wasTouch;
    const recent = this.scene.time.now - this.lastMouseMove < AUTO_AIM_AFTER_MS;
    if (!this.touchMode && (recent || mouseDown)) {
      const wx = center.x + (this.mouseX - this.scene.scale.width / 2) / zoom;
      const wy = center.y + (this.mouseY - this.scene.scale.height / 2) / zoom;
      aim = Math.atan2(wy - player.y, wx - player.x);
      aimDist = Math.hypot(wx - player.x, wy - player.y);
      firing = mouseDown;
    }
    return { moveX: mx, moveY: my, aim, aimDist, firing, dash, viewW, viewH };
  }

  /** True when the mouse is driving aim (for the crosshair). */
  get manualAim() {
    return !this.touchMode && this.scene.time.now - this.lastMouseMove < AUTO_AIM_AFTER_MS;
  }

  get mouse() {
    return { x: this.mouseX, y: this.mouseY };
  }

  destroy() {
    this.offs.forEach((f) => f());
    this.offs.length = 0;
    this.stick = null;
  }
}
