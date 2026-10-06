/** Numeric ranges in CitySpec, as [path, min, max], used to repair near-valid specs. */
export const CITY_SPEC_LIMITS: [string[], number, number][] = [
  [["terrain", "waterLevel"], 0, 1],
  [["terrain", "roughness"], 0, 1],
  [["terrain", "forest"], 0, 1],
  [["climate", "startHour"], 0, 24],
  [["climate", "dayLengthSec"], 60, 900],
  [["economy", "startingFunds"], 5_000, 200_000],
  [["economy", "taxRate"], 0, 0.2],
  [["economy", "difficulty"], 0, 1],
  [["disasters", "frequency"], 0, 1],
];
