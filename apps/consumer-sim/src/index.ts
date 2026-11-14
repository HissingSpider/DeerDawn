import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const API_KEY = process.env.API_KEY || 'dev-key';

async function main() {
  console.log(`STARTING Consumer Sim starting against ${API_URL}`);

  // Wait for API to be ready (naive)
  await new Promise(r => setTimeout(r, 5000));

  const scenarios = [
    { type: 'refund.approve', payload: { amount: 50 }, expected: 'allow' },
    { type: 'refund.approve', payload: { amount: 1000000 }, expected: 'escalate' }, // High amount
    { type: 'system.access', payload: { resource: 'admin_panel' }, expected: 'deny' } // Assuming default policy denies
  ];

  for (const scenario of scenarios) {
    const traceId = uuidv4();
    try {
      console.log(`
Testing ${scenario.type} (Trace: ${traceId})`);
      const res = await axios.post(`${API_URL}/api/v1/decisions:evaluate`, {
        action_type: scenario.type,
        trace_id: traceId,
        payload: scenario.payload
      }, {
        headers: {
          'X-Api-Key': API_KEY,
          'Content-Type': 'application/json'
        }
      });

      console.log(`   Response: ${res.status} ${res.data.decision}`);
      
      if (res.data.decision === scenario.expected || (scenario.expected === 'deny' && res.data.decision === 'deny')) {
         console.log('   PASS PASS');
      } else {
         console.log(`   FAIL FAIL: Expected ${scenario.expected}, got ${res.data.decision}`);
      }

    } catch (err: any) {
      if (err.response) {
        console.log(`   Response: ${err.response.status} ${JSON.stringify(err.response.data)}`);
      } else {
        console.error(`   FAIL Error: ${err.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\nDONE Sim run complete.');
}

main().catch(console.error);
