import { describe, it, expect } from 'vitest';
import { measureScaling, RATIO_LIMIT, SIZE_STEP } from './linear-time';

// The linearity check has to be able to fail, or it guards nothing. Run it
// against functions whose shape is known: a quadratic must land well above the
// limit and a linear one well below it.
describe('expectLinear: the check itself', () => {
  // A backtracking regex that is exactly quadratic: on 'a' x n with no 'b',
  // /a*b/ runs to the end of the string from every start position. (Two
  // stacked stars, /a*a*b/, are cubic and far too slow to use as a sample.)
  const quadratic = (n: number) => { /a*b/.test('a'.repeat(n)); };
  const linear = (n: number) => { /b/.test('a'.repeat(n)); 'a'.repeat(n).split('').reverse(); };

  it('a quadratic function is far over the ratio limit', () => {
    const { ratio, large } = measureScaling(quadratic, 32_000);
    expect(large).toBeGreaterThan(50); // slow enough that the ratio is judged
    expect(ratio).toBeGreaterThan(RATIO_LIMIT);
  });

  it('a linear function is far under it', () => {
    const { ratio } = measureScaling(linear, 2_000_000);
    expect(ratio).toBeLessThan(RATIO_LIMIT);
    expect(SIZE_STEP).toBe(16);
  });
});
