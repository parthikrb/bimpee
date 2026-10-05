import type { WorldSpec } from "@bimpee/shared";
import type { NarrateTrigger } from "./gate";

/** Canned narration used when the AI narrator is offline or fails. */
const LINES: Record<NarrateTrigger, string[]> = {
  run_start: [
    "Welcome to {world}. Try not to become part of the scenery.",
    "{world} wakes up. It has noticed you.",
    "Another hero enters {world}. The odds remain hilarious.",
  ],
  act_change: [
    "{act}. The world leans in closer.",
    "Act shift: {act}. Things are about to get personal.",
    "{act} begins. Whatever you were doing, do more of it.",
  ],
  boss_spawn: [
    "{boss} has entered the chat.",
    "Here it comes. {boss}. Breathe.",
    "The ground shakes. {boss} remembers you.",
  ],
  boss_defeated: ["{boss} falls. Somewhere, a bard starts writing.", "That was {boss}. Was.", "{boss} is down. Take a bow."],
  near_death: ["Your health bar called. It wants to talk.", "One more hit and this becomes a cautionary tale.", "Low on life. High on drama."],
  death: ["And so {world} keeps another souvenir.", "That's the run. The world will remember. Briefly.", "Down you go. {world} thanks you for playing."],
  victory: ["{world} bends the knee. Unbelievable.", "Victory. Even I'm impressed, and I'm hard to impress.", "You beat {world}. Frame this moment."],
  milestone: ["{n} down. The body count is becoming a personality.", "{n} kills. Someone is keeping score. It's me.", "That's {n}. The world is running out of minions."],
};

export function cannedLine(
  world: WorldSpec,
  trigger: NarrateTrigger,
  vars: { act?: string; n?: number } = {},
  rand: () => number = Math.random,
): string {
  const options = LINES[trigger];
  const tpl = options[Math.floor(rand() * options.length)] ?? options[0]!;
  return tpl
    .replace(/\{world\}/g, world.name)
    .replace(/\{boss\}/g, world.boss.name)
    .replace(/\{act\}/g, vars.act ?? "A new act")
    .replace(/\{n\}/g, String(vars.n ?? ""));
}
