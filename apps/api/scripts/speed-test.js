const http = require('http');
const https = require('https');
const { Client } = require('pg');
const { URL } = require('url');
const fs = require('fs');
const { hashApiKey } = require('../src/utils/security');

// --- Configuration Loading ---
const PROFILES = require('./perf/profiles.json');
const DEFAULT_FIXTURE = require('./perf/fixtures/decision.json');

// --- Argument Parsing ---
const args = process.argv.slice(2);
const getConfig = (key) => {
    const arg = args.find(a => a.startsWith(`--${key}=`));
    return arg ? arg.split('=')[1] : null;
};
const hasFlag = (key) => args.includes(`--${key}`);

const TARGET_URL = args.find(a => a.startsWith('http')) || 'http://localhost:8080';
const PROFILE_NAME = getConfig('profile') || (hasFlag('skip-setup') ? 'legacy' : 'regression');
const API_KEY = getConfig('api-key');
const PAYLOAD_PATH = getConfig('payload');
const OUTPUT_FORMAT = getConfig('output') || 'text';
const OUT_FILE = getConfig('out-file');

const profile = PROFILES[PROFILE_NAME] || PROFILES.regression; 

// Override profile with flags
const DURATION = parseInt(getConfig('duration-seconds')) || profile.duration_seconds || 60;
const WARMUP = parseInt(getConfig('warmup-seconds')) || profile.warmup_seconds || 0;
const CONCURRENCY = parseInt(getConfig('concurrency')) || profile.concurrency || 10;
const SUCCESS_ONLY = hasFlag('success-only') || profile.success_only || false;
const FAIL_ON_429 = hasFlag('fail-on-429') || profile.fail_on_429 || false;

// Capacity specific
const RAMP_ENABLED = profile.ramp_concurrency || false;
const CONCURRENCY_START = profile.concurrency_start || 5;
const CONCURRENCY_END = profile.concurrency_end || 50;
const STEP_SECONDS = profile.step_every_seconds || 30;

// --- Setup Logic ---
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://deerdawn:password@localhost:5432/deerdawn_dev';
const SETUP_ORG_ID = 'org-speed-test';
const SETUP_KEY_SECRET = 'dd_speed_test_key_999';

async function setupEnvironment() {
    if (API_KEY) return API_KEY; 

    console.log('No API Key provided. Attempting database setup...');
    const isLocal = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1') || DATABASE_URL.includes('postgres');
    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: isLocal ? false : { rejectUnauthorized: true }
    });

    try {
        await client.connect();
        
        await client.query(
            'INSERT INTO organizations (org_id, name, subscription_status, plan) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id) DO NOTHING',
            [SETUP_ORG_ID, 'Speed Test Corp', 'active', 'enterprise']
        );

        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        const keyHash = hashApiKey(SETUP_KEY_SECRET);
        
        await client.query(`
            INSERT INTO api_keys (key_id, prefix, key_hash, name, org_id, environment, expires_at) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (key_id) DO NOTHING`,
        ['key-speed-test', 'dd_speed', keyHash, 'Speed Test Key', SETUP_ORG_ID, 'production', expiresAt.toISOString()]
        );

        await client.query(`
            INSERT INTO policies (policy_id, name, org_id, enabled, priority, action_types, effect, conditions, reason, version)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (policy_id) DO UPDATE SET conditions = $8`,
        [
            'pol-speed-test', 
            'Speed Test Policy', 
            SETUP_ORG_ID, 
            true, 
            1, 
            JSON.stringify(['refund.approve']), 
            'allow',
            JSON.stringify([{ field: 'payload.amount', op: 'gte', value: 100 }]), 
            'Performance benchmarking',
            1
        ]
        );

        console.log('Environment ready. Using generated key.');
        return SETUP_KEY_SECRET;
    } catch (err) {
        console.warn(' Setup failed (likely no DB access). Running without setup if key is valid...');
        if (!API_KEY) {
            console.error('Error: No API Key provided and DB setup failed. Cannot proceed.');
            process.exit(1);
        }
        return API_KEY;
    } finally {
        await client.end().catch(() => {});
    }
}

// --- Load Generator ---

function getPayload() {
    if (PAYLOAD_PATH) {
        return JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8'));
    }
    return DEFAULT_FIXTURE;
}

const globalStats = {
    latencies: [], 
    successLatencies: [], 
    errors: 0, 
    statusCounts: {} 
};

function record(duration, status, isError) {
    if (!isError && status < 400) {
        globalStats.successLatencies.push(duration);
    }
    globalStats.latencies.push(duration);
    globalStats.statusCounts[status] = (globalStats.statusCounts[status] || 0) + 1;
    if (status >= 400 || isError) {
        globalStats.errors++;
    }
}

function clearStats() {
    globalStats.latencies = [];
    globalStats.successLatencies = [];
    globalStats.errors = 0;
    globalStats.statusCounts = {};
}

async function runPhase(label, durationSec, concurrency, apiKey) {
    if (durationSec <= 0) return;
    
    console.log(`
Starting Phase: ${label}`);
    console.log(`   Duration: ${durationSec}s | Concurrency: ${concurrency}`);

    const parsedUrl = new URL(TARGET_URL);
    const agent = new (parsedUrl.protocol === 'https:' ? https : http).Agent({
        keepAlive: true,
        maxSockets: concurrency
    });

    const endTime = Date.now() + (durationSec * 1000);
    const basePayload = getPayload();
    
    return new Promise((resolve) => {
        const workers = [];

        const worker = async (id) => {
            while (Date.now() < endTime) {
                const reqStart = Date.now();
                const traceId = `perf-${label}-${id}-${Date.now()}`;
                const payload = JSON.parse(JSON.stringify(basePayload));
                payload.trace_id = traceId;
                const body = JSON.stringify(payload);

                try {
                    await new Promise((resReq) => {
                        const options = {
                            hostname: parsedUrl.hostname,
                            port: parsedUrl.port,
                            path: '/api/v1/decisions:evaluate', 
                            method: 'POST',
                            agent: agent,
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': body.length,
                                'X-API-Key': apiKey
                            }
                        };

                        const lib = parsedUrl.protocol === 'https:' ? https : http;
                        const req = lib.request(options, (res) => {
                            res.on('data', () => {}); 
                            res.on('end', () => {
                                record(Date.now() - reqStart, res.statusCode, false);
                                resReq();
                            });
                        });

                        req.on('error', (_e) => {
                            record(Date.now() - reqStart, 0, true);
                            resReq();
                        });

                        req.write(body);
                        req.end();
                    });
                } catch (e) {
                    // loop continue
                }
            }
        };

        for (let i = 0; i < concurrency; i++) workers.push(worker(i));
        Promise.all(workers).then(resolve);
    });
}

function calculatePercentiles(data) {
    if (data.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, max: 0 };
    data.sort((a, b) => a - b);
    const sum = data.reduce((a, b) => a + b, 0);
    return {
        p50: data[Math.floor(data.length * 0.50)],
        p95: data[Math.floor(data.length * 0.95)],
        p99: data[Math.floor(data.length * 0.99)],
        max: data[data.length - 1],
        avg: Math.round(sum / data.length)
    };
}

function checkThresholds(statsData, thresholds) {
    const successData = SUCCESS_ONLY ? statsData.successLatencies : statsData.latencies;
    const metrics = calculatePercentiles(successData);
    const failures = [];
    
    if (statsData.latencies.length > 0 && statsData.successLatencies.length === 0) {
        failures.push('No successful requests recorded (100% error rate)');
    }
    if (thresholds.p95_success_ms && metrics.p95 > thresholds.p95_success_ms) {
        failures.push(`p95 latency ${metrics.p95}ms > ${thresholds.p95_success_ms}ms`);
    }
    if (thresholds.max_error_rate !== undefined) {
        const rate = statsData.errors / statsData.latencies.length;
        if (rate > thresholds.max_error_rate) failures.push(`Error rate ${(rate*100).toFixed(2)}% > limit`);
    }
    if (FAIL_ON_429 && (statsData.statusCounts[429] || 0) > 0) {
        failures.push('Rate limited (429)');
    }
    return failures;
}

function printReport(finalStats, thresholdConfig, passed, failures) {
    const successData = SUCCESS_ONLY ? finalStats.successLatencies : finalStats.latencies;
    const metrics = calculatePercentiles(successData);
    const allMetrics = calculatePercentiles(finalStats.latencies);
    
    const totalReqs = finalStats.latencies.length;
    const rps = (totalReqs / DURATION).toFixed(2);
    const errorRate = finalStats.errors / totalReqs;

    if (OUTPUT_FORMAT === 'json') {
        const output = {
            meta: { profile: PROFILE_NAME, timestamp: new Date().toISOString(), target: TARGET_URL },
            config: { duration: DURATION, concurrency: CONCURRENCY },
            results: { total_requests: totalReqs, rps: parseFloat(rps), error_count: finalStats.errors, error_rate: errorRate, status_counts: finalStats.statusCounts },
            latency: { success_only: metrics, all: allMetrics },
            verdict: { pass: passed, reasons: failures }
        };
        const jsonStr = JSON.stringify(output, null, 2);
        if (OUT_FILE) { fs.writeFileSync(OUT_FILE, jsonStr); console.log(`\nReport written to ${OUT_FILE}`); }
        else console.log(jsonStr);
    } else {
        console.log('\n\n--- Performance Report ---');
        console.log(`Profile: ${PROFILE_NAME.toUpperCase()} | Target: ${TARGET_URL}`);
        console.log(`Requests: ${totalReqs} (${rps} req/sec)`);
        console.log(`Errors:   ${finalStats.errors} (${(errorRate * 100).toFixed(2)}%)`);
        
        if (finalStats.errors > 0) {
            console.log('Error Breakdown:');
            Object.entries(finalStats.statusCounts).forEach(([code, count]) => {
                if (code !== '200' && code !== '201') {
                    const label = code === '0' ? 'Network/Timeout' : `HTTP ${code}`;
                    console.log(`   - ${label}: ${count}`);
                }
            });
        }

        console.log(`p95:      ${metrics.p95}ms (Success Only)`);
        if (passed) console.log('VERDICT: PASS');
        else {
            console.log('VERDICT: FAIL');
            failures.forEach(f => console.log(`   - ${f}`));
        }
    }
}

// --- Main ---
async function main() {
    const apiKey = await setupEnvironment();
    
    if (RAMP_ENABLED) {
        console.log(`Running Capacity Test (Ramp ${CONCURRENCY_START} -> ${CONCURRENCY_END})`);
        let currentConcurrency = CONCURRENCY_START;
        
        while (currentConcurrency <= CONCURRENCY_END) {
            clearStats();
            await runPhase(`step-${currentConcurrency}`, STEP_SECONDS, currentConcurrency, apiKey);
            
            const metrics = calculatePercentiles(globalStats.successLatencies);
            
            console.log(`   Result @ ${currentConcurrency}: p95=${metrics.p95}ms, Errors=${globalStats.errors}`);
            
            const failures = checkThresholds(globalStats, profile.stop_conditions || {});
            
            if (failures.length > 0) {
                console.log(`\nKnee point found at concurrency ${currentConcurrency}`);
                failures.forEach(f => console.log(`   - ${f}`));
                process.exit(0); 
            }
            
            currentConcurrency += 5; // Step size fixed for now or calc from config
        }
        console.log('\nReached max concurrency without breaking thresholds.');
    } else {
        // Standard Profile
        if (WARMUP > 0) {
            clearStats(); // Don't record warmup
            await runPhase('warmup', WARMUP, CONCURRENCY, apiKey);
            clearStats();
        }

        await runPhase('measure', DURATION, CONCURRENCY, apiKey);
        
        const failures = checkThresholds(globalStats, profile.thresholds || {});
        printReport(globalStats, profile.thresholds, failures.length === 0, failures);
        process.exit(failures.length === 0 ? 0 : 2);
    }
}

main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(4);
});
