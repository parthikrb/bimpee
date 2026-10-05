// Placeholder: replaced by the Phaser implementation.
import { Bus, type CreateGame, type GameToShell, type ShellToGame } from "./contract";

export const createGame: CreateGame = () => {
  const out = new Bus<GameToShell>();
  const inn = new Bus<ShellToGame>();
  return { out, in: inn, destroy: () => (out.clear(), inn.clear()) };
};
