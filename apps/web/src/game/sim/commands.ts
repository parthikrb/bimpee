import type { Bus, ShellToGame } from "../contract";
import type { Sim } from "./Sim";

/**
 * Wires ShellToGame commands into the simulation (ghosts are handled by the
 * renderer). Returns a function that removes every listener it added.
 */
export function connectCommands(sim: Sim, inn: Bus<ShellToGame>): () => void {
  const offs = [
    inn.on("directives", (list) => sim.applyDirectives(Array.isArray(list) ? list : [])),
    inn.on("pick_upgrade", (id) => sim.pickUpgrade(String(id))),
    inn.on("pause", () => sim.pause()),
    inn.on("resume", () => sim.resume()),
    inn.on("quit", () => sim.quit()),
  ];
  return () => offs.forEach((off) => off());
}
