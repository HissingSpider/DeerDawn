/**
 * Extraction Quality Test
 *
 * Tests the LLM extraction pipeline against realistic MCP + dashboard usage
 * scenarios to verify that extracted context is actually useful, not just
 * structurally valid.
 *
 * Requires OPENAI_API_KEY or ANTHROPIC_API_KEY. Skips live LLM calls if
 * neither is set, but still verifies the non-LLM paths (trivial suppression,
 * heuristic matching, safe fallbacks).
 *
 * Run: node tests/unit/extraction-quality.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Load env from .env if present
try { require('dotenv').config(); } catch (_) { /* optional */ }

const { runExtraction } = require('../../src/services/extractionService');

const HAS_LLM = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
const SYSTEM_ACTOR = { id: 'quality-test', org_id: 'org-quality-test' };


// Quality assertions
function assertSpecificTask(result, label) {
  const task = result.delta?.current_task || '';
  assert.ok(task.length > 15, `${label}: current_task too short/generic: "${task}"`);
  const generics = ['working on', 'doing stuff', 'coding', 'development', 'programming'];
  const isGeneric = generics.some(g => task.toLowerCase().trim() === g);
  assert.ok(!isGeneric, `${label}: current_task is too generic: "${task}"`);
}

function assertHighConfidence(result, label) {
  assert.ok(result.confidence >= 0.65, `${label}: confidence too low: ${result.confidence}`);
}

function assertTechStack(result, label, expectedTerms) {
  const stack = (result.delta?.tech_stack || []).map(t => t.toLowerCase()).join(' ');
  for (const term of expectedTerms) {
    assert.ok(stack.includes(term.toLowerCase()), `${label}: missing "${term}" in tech_stack: [${result.delta?.tech_stack?.join(', ')}]`);
  }
}

function assertDecision(result, label) {
  const decisions = result.delta?.recent_decisions || [];
  assert.ok(decisions.length > 0, `${label}: no recent_decisions extracted`);
  const d = decisions[0];
  assert.ok(d.summary?.length > 10, `${label}: decision summary too short: "${d.summary}"`);
  assert.ok(['low', 'normal', 'high', 'critical'].includes(d.importance), `${label}: bad importance: "${d.importance}"`);
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = {
  newProject: {
    label: 'New MCP project — detects task, tech, and new-project signal',
    input: {
      session_id: 'sess-quality-new',
      tool: 'claude_code',
      chunks: [
        {
          role: 'user',
          text: 'I\'m starting a new project called ContextBridge. It\'s a TypeScript Node.js service that syncs AI context between tools using an MCP server and a PostgreSQL database. The first thing I need to build is the session management layer — specifically a SessionStore class that tracks active MCP sessions with a 30-minute TTL.',
        },
        {
          role: 'assistant',
          text: 'Got it — a TypeScript Node.js service with MCP + PostgreSQL for AI context sync. I\'ll start with the SessionStore class. Should we use ioredis for the TTL or pure PostgreSQL with a cron cleanup?',
        },
        {
          role: 'user',
          text: 'Let\'s use PostgreSQL for now to keep it simple. We can add Redis later if latency becomes an issue.',
        },
      ],
    },
    assertions(result) {
      assertHighConfidence(result, 'newProject');
      assertSpecificTask(result, 'newProject');
      assertTechStack(result, 'newProject', ['typescript', 'postgresql']);
      assertDecision(result, 'newProject');
      assert.ok(
        result.delta?.recent_decisions?.some(d => /postgresql|postgres|redis/i.test(d.summary)),
        'newProject: should capture the PostgreSQL vs Redis decision',
      );
    },
  },

  architecturalDecision: {
    label: 'Critical architectural decision — captured with correct importance',
    input: {
      session_id: 'sess-quality-arch',
      tool: 'claude_code',
      chunks: [
        {
          role: 'user',
          text: 'We\'ve decided to drop the monolithic Express app and split everything into microservices. Auth, billing, and context-sync are now separate services behind an API gateway. This is a permanent architecture change — the old codebase will be archived.',
        },
        {
          role: 'assistant',
          text: 'Understood. Microservices split with separate auth, billing, and context-sync services behind a gateway. Archiving the monolith.',
        },
      ],
    },
    assertions(result) {
      assertHighConfidence(result, 'archDecision');
      assertDecision(result, 'archDecision');
      const decisions = result.delta?.recent_decisions || [];
      const d = decisions[0];
      assert.ok(
        ['high', 'critical'].includes(d.importance),
        `archDecision: architectural split should be high/critical importance, got "${d.importance}"`,
      );
    },
  },

  blockingIssue: {
    label: 'Blocking issue — extracted into blocking_issue field',
    input: {
      session_id: 'sess-quality-block',
      tool: 'claude_code',
      chunks: [
        {
          role: 'user',
          text: 'I can\'t proceed with the payment integration until Stripe confirms our account is approved for live mode. We\'re stuck waiting on their compliance review and there\'s nothing we can do in the meantime.',
        },
      ],
    },
    assertions(result) {
      const blocking = result.delta?.blocking_issue || '';
      assert.ok(blocking.length > 10, `blockingIssue: blocking_issue not extracted: "${blocking}"`);
      assert.ok(/stripe|payment|compliance|review/i.test(blocking), `blockingIssue: blocking_issue doesn't mention the actual blocker: "${blocking}"`);
    },
  },

  commandExtraction: {
    label: 'Run command mentioned — extracted into commands field',
    input: {
      session_id: 'sess-quality-cmd',
      tool: 'claude_code',
      chunks: [
        {
          role: 'user',
          text: 'To deploy to production I run: fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile from the monorepo root. And to run tests it\'s npm test from apps/api/.',
        },
      ],
    },
    assertions(result) {
      const commands = result.delta?.commands || [];
      assert.ok(commands.length > 0, 'commandExtraction: no commands extracted');
      const hasDeployCmd = commands.some(c => /fly.deploy/i.test(c.run) || c.label === 'deploy');
      assert.ok(hasDeployCmd, `commandExtraction: deploy command not extracted: ${JSON.stringify(commands)}`);
    },
  },

  trivialSuppression: {
    label: 'Trivial input — suppressed without LLM call',
    input: {
      session_id: 'sess-quality-trivial',
      tool: 'claude_code',
      chunks: [{ role: 'user', text: 'ok thanks' }],
    },
    assertions(result) {
      assert.ok(result.no_material_change === true, `trivial: should be no_material_change, got ${JSON.stringify(result)}`);
      assert.strictEqual(result.match_decision, 'ignored', `trivial: should be ignored, got "${result.match_decision}"`);
    },
    live: false, // trivial detection is pre-LLM, always runs
  },

  emojiOnlySuppression: {
    label: 'Emoji-only input — suppressed without LLM call',
    input: {
      session_id: 'sess-quality-emoji',
      tool: 'claude_code',
      chunks: [{ role: 'user', text: '👍' }],
    },
    assertions(result) {
      assert.ok(result.no_material_change === true, 'emoji: should be no_material_change');
    },
    live: false,
  },

  contextlessTriviaIgnored: {
    label: 'One-off trivia with no durable subject — ignored',
    input: {
      session_id: 'sess-quality-trivia',
      tool: 'claude_code',
      chunks: [
        { role: 'user', text: 'What\'s the capital of Australia?' },
        { role: 'assistant', text: 'The capital of Australia is Canberra.' },
      ],
    },
    assertions(result) {
      assert.ok(
        result.match_decision === 'ignored' || result.no_material_change === true,
        `trivia: should be ignored or no_material_change, got match_decision="${result.match_decision}"`,
      );
    },
  },

  lifeTopicCaptured: {
    label: 'Non-coding life topic — captured as a topic (not ignored)',
    input: {
      session_id: 'sess-quality-lifetopic',
      tool: 'claude_web',
      chunks: [
        {
          role: 'user',
          text: 'I\'m planning to climb Mount Shasta in July. Trying to figure out the gear I need and whether to do the Avalanche Gulch route.',
        },
        {
          role: 'assistant',
          text: 'For Avalanche Gulch in July you\'ll want crampons, an ice axe, and a helmet. Acclimatize at Horse Camp the night before the summit push.',
        },
      ],
    },
    assertions(result) {
      // The whole point of P2: an ongoing personal subject is now tracked, not dropped.
      assert.ok(result.match_decision !== 'ignored', `lifeTopic: should not be ignored, got "${result.match_decision}"`);
      assert.ok(result.no_material_change !== true, 'lifeTopic: should be a material change worth tracking');
      if (result.delta?.category) {
        assert.strictEqual(result.delta.category, 'topic', 'lifeTopic: classified as a topic');
      }
    },
  },

  userProfileExtraction: {
    label: 'User self-description — stays out of the profile (owner decision: the profile is never learned from a conversation)',
    input: {
      session_id: 'sess-quality-profile',
      tool: 'claude_code',
      chunks: [
        {
          role: 'user',
          text: 'I\'ve been writing Go for 8 years but I\'m new to TypeScript and the Node.js ecosystem. I prefer to ship fast and iterate rather than over-engineer upfront. I really care about clean API design and good error messages for developers.',
        },
      ],
    },
    assertions(result) {
      assert.ok(!result.delta?.you_profile, `userProfile: extraction returned a you_profile: ${JSON.stringify(result.delta?.you_profile)}`);
    },
  },
};

// ─── Test runner ─────────────────────────────────────────────────────────────

test('Extraction quality — non-LLM paths always run', async (t) => {
  for (const [_key, scenario] of Object.entries(SCENARIOS)) {
    if (scenario.live !== false) continue;
    await t.test(scenario.label, async () => {
      const result = await runExtraction(SYSTEM_ACTOR, scenario.input);
      scenario.assertions(result);
    });
  }
});

test('Extraction quality — live LLM scenarios', async (t) => {
  if (!HAS_LLM) {
    console.log('\n  [INFO] Skipping live LLM quality checks — set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable.');
    return;
  }

  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    if (scenario.live === false) continue;
    await t.test(scenario.label, async () => {
      const result = await runExtraction(SYSTEM_ACTOR, scenario.input);

      // Always: result must be structurally valid
      assert.ok(result, 'result must not be null/undefined');
      assert.ok(typeof result.match_decision === 'string', 'match_decision must be a string');
      assert.ok(typeof result.confidence === 'number', 'confidence must be a number');
      assert.ok(typeof result.no_material_change === 'boolean', 'no_material_change must be a boolean');

      // Scenario-specific quality assertions
      scenario.assertions(result);

      // Log what was extracted for inspection
      console.log(`\n  [${key}] match=${result.match_decision} conf=${result.confidence} no_change=${result.no_material_change}`);
      if (result.delta?.current_task) console.log(`    task: ${result.delta.current_task}`);
      if (result.delta?.tech_stack?.length) console.log(`    stack: ${result.delta.tech_stack.join(', ')}`);
      if (result.delta?.recent_decisions?.length) console.log(`    decisions: ${result.delta.recent_decisions.map(d => `[${d.importance}] ${d.summary}`).join(' | ')}`);
      if (result.delta?.blocking_issue) console.log(`    blocking: ${result.delta.blocking_issue}`);
      if (result.delta?.commands?.length) console.log(`    commands: ${result.delta.commands.map(c => c.label).join(', ')}`);
    });
  }
});
