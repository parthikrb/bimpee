import { generateFallbackWorld, LAYOUTS } from "@bimpee/shared";
import { describe, expect, it } from "vitest";
import { FlowField } from "./flowfield";
import { CENTER_CLEAR_TILES, circleFree, floodOpen, generateMap, isSolidTile, openCount, resolveCircle } from "./mapgen";

const sizes = ["small", "medium", "large"] as const;

describe("generateMap", () => {
  for (const kind of LAYOUTS) {
    for (const density of [0, 0.5, 1]) {
      it(`${kind} @ density ${density}: deterministic, centre clear, connected, bordered`, () => {
        for (const seed of [1, 42, 99_999, 2_000_000_000]) {
          const size = sizes[seed % 3]!;
          const spec = { seed, layout: { kind, density, size } };
          const a = generateMap(spec);
          const b = generateMap(spec);
          expect(Buffer.from(a.solid).equals(Buffer.from(b.solid))).toBe(true);
          expect(Buffer.from(a.pool).equals(Buffer.from(b.pool))).toBe(true);

          // centre clear
          const cc = Math.floor(a.cols / 2);
          const cr = Math.floor(a.rows / 2);
          for (let r = cr - CENTER_CLEAR_TILES + 1; r <= cr + CENTER_CLEAR_TILES - 1; r++)
            for (let c = cc - 2; c <= cc + 2; c++) expect(isSolidTile(a, c, r)).toBe(false);
          expect(circleFree(a, a.spawnX, a.spawnY, 120)).toBe(true);

          // border
          for (let c = 0; c < a.cols; c++) {
            expect(a.solid[c]).toBe(1);
            expect(a.solid[(a.rows - 1) * a.cols + c]).toBe(1);
          }

          // connectivity: every open tile reachable from the centre
          const reached = floodOpen(a.cols, a.rows, a.solid, cc, cr);
          let reachedCount = 0;
          for (let i = 0; i < reached.length; i++) reachedCount += reached[i]!;
          expect(reachedCount).toBe(openCount(a));

          // playable amount of floor
          expect(openCount(a) / (a.cols * a.rows)).toBeGreaterThan(0.3);
        }
      });
    }
  }

  it("different seeds produce different maps", () => {
    const a = generateMap({ seed: 1, layout: { kind: "caverns", density: 0.5, size: "medium" } });
    const b = generateMap({ seed: 2, layout: { kind: "caverns", density: 0.5, size: "medium" } });
    expect(Buffer.from(a.solid).equals(Buffer.from(b.solid))).toBe(false);
  });

  it("arena size follows layout.size", () => {
    const s = generateMap({ seed: 3, layout: { kind: "arena", density: 0.3, size: "small" } });
    const l = generateMap({ seed: 3, layout: { kind: "arena", density: 0.3, size: "large" } });
    expect(s.width).toBeGreaterThan(1700);
    expect(s.width).toBeLessThan(1900);
    expect(l.width).toBeGreaterThan(3300);
  });

  it("works with fallback worlds", () => {
    for (let seed = 0; seed < 20; seed++) {
      const w = generateFallbackWorld(seed);
      const m = generateMap(w);
      expect(circleFree(m, m.spawnX, m.spawnY, 60)).toBe(true);
    }
  });
});

describe("collision", () => {
  const m = generateMap({ seed: 7, layout: { kind: "maze", density: 0.6, size: "small" } });
  it("resolveCircle pushes circles out of walls and keeps them finite", () => {
    for (let i = 0; i < 2000; i++) {
      const p = { x: (i * 7919) % m.width, y: (i * 104729) % m.height };
      resolveCircle(m, p, 14);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      resolveCircle(m, p, 14);
      expect(p.x).toBeGreaterThanOrEqual(14);
      expect(p.y).toBeLessThanOrEqual(m.height - 14);
    }
  });
});

describe("FlowField", () => {
  it("leads from any reachable tile to the goal", () => {
    const m = generateMap({ seed: 11, layout: { kind: "rooms", density: 0.7, size: "small" } });
    const f = new FlowField(m);
    f.update(m.spawnX, m.spawnY);
    const out = { x: 0, y: 0 };
    let checked = 0;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.cols; c++) {
        if (isSolidTile(m, c, r)) continue;
        // follow the field; must arrive within dist steps
        let x = c * m.tile + 32;
        let y = r * m.tile + 32;
        const start = f.distanceAt(x, y);
        expect(start).toBeGreaterThanOrEqual(0);
        for (let s = 0; s < start + 2 && f.distanceAt(x, y) > 0; s++) {
          f.directionAt(x, y, out);
          x += Math.round(out.x) * m.tile;
          y += Math.round(out.y) * m.tile;
        }
        expect(f.distanceAt(x, y)).toBe(0);
        checked++;
      }
    expect(checked).toBeGreaterThan(100);
  });
});
