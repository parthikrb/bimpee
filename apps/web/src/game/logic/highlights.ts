/**
 * Detects notable moments for the RunReport ("Survived blackout at 12% hp").
 * Pure; the simulation calls the hooks.
 */
export const MAX_HIGHLIGHTS = 20;
const KILL_MILESTONES = [100, 200, 300, 500, 750, 1000, 1500];
const LEVEL_MILESTONES = [10, 15, 20, 30];
const ELITE_MILESTONES = [10, 25, 50];

const pct = (f: number) => `${Math.max(0, Math.round(f * 100))}%`;

export class HighlightTracker {
  readonly list: string[] = [];
  private lowest = 1;
  private recovering = false;

  add(text: string) {
    if (this.list.length >= MAX_HIGHLIGHTS || this.list.includes(text)) return;
    this.list.push(text.slice(0, 120));
  }

  onKills(total: number) {
    if (KILL_MILESTONES.includes(total)) this.add(`${total} kills`);
  }
  onEliteKills(total: number) {
    if (ELITE_MILESTONES.includes(total)) this.add(`${total} elites destroyed`);
  }
  onLevel(level: number) {
    if (LEVEL_MILESTONES.includes(level)) this.add(`Reached level ${level}`);
  }
  /** Call every frame with current hp fraction. Detects comebacks from near death. */
  onHp(frac: number) {
    if (frac < this.lowest) this.lowest = frac;
    if (frac > 0 && frac < 0.1) this.recovering = true;
    if (this.recovering && frac >= 0.5) {
      this.recovering = false;
      this.add(`Clawed back from ${pct(this.lowest)} hp`);
    }
  }
  onBlackoutSurvived(minHpFrac: number) {
    this.add(`Survived blackout at ${pct(minHpFrac)} hp`);
  }
  onBossKilled(bossName: string, hpFrac: number, fightSec: number) {
    if (hpFrac < 0.25) this.add(`Killed ${bossName} with ${pct(hpFrac)} hp left`);
    else this.add(`Defeated ${bossName} in ${Math.round(fightSec)}s`);
  }
  onRivalKilled() {
    this.add("Destroyed their mirror rival");
  }
  onEventSurvived(kind: string, hpFrac: number) {
    if (hpFrac < 0.3) this.add(`Survived ${kind.replace(/_/g, " ")} at ${pct(hpFrac)} hp`);
  }
  get lowestHp() {
    return this.lowest;
  }
}
