import { expect } from 'vitest';

/**
 * Asserts that `run` scales linearly in input size, robustly enough for a
 * shared CI runner.
 *
 * What this guards is catastrophic regex backtracking, which is never a few
 * percent: a quadratic pattern is ~256x slower on 16x the input, and the one
 * that motivated these tests took 31 SECONDS on 200 KB. The old checks bounded
 * a ratio at 30 on a 10x step (linear ~10, so 3x headroom) and one case at an
 * absolute 200 ms; both flaked on runners (31.96 against 30, 239.8 ms against
 * 200) with nothing wrong.
 *
 * So: a 16x size step, best of three runs at each size (one descheduled run is
 * a scheduler fact, not a property of the pattern), and a ratio limit of 64,
 * which sits 4x above linear (16) and 4x below quadratic (256). The ratio is
 * only judged once the large run is slow enough to measure; below that the
 * absolute backstop is the whole check, and a quadratic shape is never that
 * fast at this size. tests/helpers/linear-time.test.ts proves the check fails
 * on a quadratic function and passes on a linear one.
 */
export const SIZE_STEP = 16;
export const RATIO_LIMIT = 64;
export const MEASURABLE_MS = 50;
export const BACKSTOP_MS = 2000;

function millis(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

export function measureScaling(run: (n: number) => void, largeN: number): { small: number; large: number; ratio: number } {
  const smallN = Math.floor(largeN / SIZE_STEP);
  run(Math.min(2_000, smallN)); // warm the JIT so the first call is not the measured one
  const best = (n: number) => Math.min(millis(() => run(n)), millis(() => run(n)), millis(() => run(n)));
  const small = Math.max(best(smallN), 0.5);
  const large = best(largeN);
  return { small, large, ratio: large / small };
}

export function expectLinear(run: (n: number) => void, largeN: number, label = ''): void {
  const { small, large, ratio } = measureScaling(run, largeN);
  const detail = `${label} ${small.toFixed(1)}ms -> ${large.toFixed(1)}ms (x${ratio.toFixed(1)} for x${SIZE_STEP} input)`.trim();
  if (large > MEASURABLE_MS) expect(ratio, detail).toBeLessThan(RATIO_LIMIT);
  expect(large, detail).toBeLessThan(BACKSTOP_MS);
}
