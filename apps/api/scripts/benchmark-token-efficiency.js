'use strict';

const fs = require('fs');
const path = require('path');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function formatPct(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function runBenchmark(filePath, thresholdPct = 5) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];

  if (!sessions.length) {
    throw new Error('Input file must contain a non-empty "sessions" array.');
  }

  const savings = sessions.map((session) => {
    const baseline = Number(session.baseline_tokens || 0);
    const injected = Number(session.injected_tokens || 0);
    if (!baseline || baseline < 0 || injected < 0) {
      throw new Error(`Invalid token values for session "${session.id || 'unknown'}".`);
    }
    const saved = baseline - injected;
    const savedPct = (saved / baseline) * 100;
    return { id: session.id || 'unknown', baseline, injected, saved, savedPct };
  });

  const pctSeries = savings.map((entry) => entry.savedPct);
  const medianPct = percentile(pctSeries, 50);
  const p25Pct = percentile(pctSeries, 25);
  const p75Pct = percentile(pctSeries, 75);

  const totalBaseline = savings.reduce((sum, entry) => sum + entry.baseline, 0);
  const totalInjected = savings.reduce((sum, entry) => sum + entry.injected, 0);
  const totalSavedPct = ((totalBaseline - totalInjected) / totalBaseline) * 100;

  console.log('[token-benchmark] Sessions evaluated:', savings.length);
  console.log('[token-benchmark] Total baseline tokens:', totalBaseline);
  console.log('[token-benchmark] Total injected tokens:', totalInjected);
  console.log('[token-benchmark] Net savings:', formatPct(totalSavedPct));
  console.log('[token-benchmark] Median savings:', formatPct(medianPct));
  console.log('[token-benchmark] P25/P75 savings:', `${formatPct(p25Pct)} / ${formatPct(p75Pct)}`);

  const passes = medianPct >= thresholdPct;
  if (!passes) {
    console.error(`[token-benchmark] FAIL: median savings ${formatPct(medianPct)} is below threshold ${thresholdPct.toFixed(2)}%.`);
    process.exit(1);
  }

  console.log(`[token-benchmark] PASS: median savings meets threshold ${thresholdPct.toFixed(2)}%.`);
}

if (require.main === module) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node apps/api/scripts/benchmark-token-efficiency.js <input-json> [threshold-percent]');
    process.exit(1);
  }
  const threshold = Number(process.argv[3] || 5);
  runBenchmark(inputPath, Number.isFinite(threshold) ? threshold : 5);
}

module.exports = { runBenchmark };
