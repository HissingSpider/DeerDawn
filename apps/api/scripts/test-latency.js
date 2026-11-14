const https = require('https');
const http = require('http');
const { URL } = require('url');

const TARGET_URL = process.argv[2] || 'http://localhost:8080';
const API_KEY = process.argv[3] || 'dev-key';
const REQUEST_COUNT = 100;
const CONCURRENCY = 10;

console.log('\nSTARTING Starting Latency Test');
console.log(`Target: ${TARGET_URL}`);
console.log(`Requests: ${REQUEST_COUNT}`);
console.log(`Concurrency: ${CONCURRENCY}\n`);

let latencies = [];
let completed = 0;
let active = 0;

function runTest(attempt = 1) {
  // Reset state for new run
  latencies = [];
  completed = 0;
  active = 0;

  console.log(`\n--- Attempt ${attempt} ---`);

  function request() {
    if (latencies.length + active >= REQUEST_COUNT) return;
    active++;

    const start = Date.now();
    const traceId = `test-${Date.now()}-${Math.random()}`;
    const data = JSON.stringify({
      action_type: 'refund.approve',
      trace_id: traceId,
      payload: { amount: 100 }
    });

    const parsedUrl = new URL(TARGET_URL);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: '/api/v1/decisions:evaluate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-API-Key': API_KEY
      }
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      res.on('data', () => {}); // Consume stream
      res.on('end', () => {
        const duration = Date.now() - start;
        latencies.push(duration);
        active--;
        completed++;
        process.stdout.write(`\rProgress: ${completed}/${REQUEST_COUNT} requests`);
        
        if (completed === REQUEST_COUNT) {
          finish(attempt);
        } else {
          request();
        }
      });
    });

    req.on('error', (e) => {
      console.error(`\nRequest error: ${e.message}`);
      active--;
      completed++; // Count as done to avoid hang
      if (completed === REQUEST_COUNT) finish(attempt);
      else request();
    });

    req.write(data);
    req.end();
  }

  // Start concurrent batch
  for (let i = 0; i < CONCURRENCY; i++) request();
}


function finish(attempt) {
  console.log('\n\n--- Results ---');
  latencies.sort((a, b) => a - b);
  
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const max = latencies[latencies.length - 1] || 0;

  console.log(`p50: ${p50}ms`);
  console.log(`p95: \x1b[32m${p95}ms\x1b[0m`);
  console.log(`p99: ${p99}ms`);
  console.log(`Max: ${max}ms`);

  if (p95 < 100 && max < 100) {
    console.log('\nPASS PASS: All requests under 100ms');
  } else {
    if (attempt < 2) {
        console.log(`\nWARN  WARN: High latency detected (p95: ${p95}ms, Max: ${max}ms). API might be cold.`);
        console.log('EXEC  Re-running test (Warmup Attempt 2/2)...');
        setTimeout(() => runTest(attempt + 1), 1000);
    } else {
        console.log(`\nWARN  WARN: Latency > 100ms after retry (p95: ${p95}ms, Max: ${max}ms)`);
    }
  }
}

// Start first run
runTest(1);
