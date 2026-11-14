const db = require('../config/db');
const { normalizePlanId } = require('../config/plans');

const TEMPLATE_OPTIONS = ['generic', 'refund_gate', 'agent_approvals', 'webhook_guardrails'];

const ACTIVATION_DEFAULTS = {
    refund_gate: {
        recommended_policy_template: 'refund_auto_approve',
        sample_action_type: 'refund.approve',
        sample_payload: {
            amount: 42,
            currency: 'USD',
            customer_tier: 'standard',
            channel: 'support',
        },
    },
    agent_approvals: {
        recommended_policy_template: 'ai_guardrails',
        sample_action_type: 'payment.send',
        sample_payload: {
            amount: 250,
            currency: 'USD',
            destination: 'vendor_account',
            requested_by: 'agent',
        },
    },
    webhook_guardrails: {
        recommended_policy_template: 'database_write_escalate',
        sample_action_type: 'database.write',
        sample_payload: {
            table: 'customers',
            operation: 'update',
            fields: ['plan_tier', 'billing_status'],
        },
    },
    generic: {
        recommended_policy_template: 'email_approval_required',
        sample_action_type: 'email.send',
        sample_payload: {
            recipient: 'user@example.com',
            subject: 'Test message',
            risk: 'medium',
        },
    },
};

function getTemplateLabel(template) {
    switch (template) {
    case 'refund_gate':
        return 'Refund Gate';
    case 'agent_approvals':
        return 'Agent approvals';
    case 'webhook_guardrails':
        return 'Webhook guardrails';
    default:
        return 'Custom API / Generic AI decisions';
    }
}

function normalizeTemplate(template, orgPlan) {
    if (TEMPLATE_OPTIONS.includes(template)) return template;
    if (normalizePlanId(orgPlan) === 'pilot') return 'refund_gate';
    return 'generic';
}

function getRecommendedNextStep(progress) {
    if (!progress.account) return '/signup';
    if (!progress.api_key) return '/api-keys';
    if (!progress.integration) return '/integrations';
    if (!progress.billing) return '/settings/plan';
    return '/';
}

function getActivationState(template, progress) {
    const defaults = ACTIVATION_DEFAULTS[template] || ACTIVATION_DEFAULTS.generic;
    return {
        ...defaults,
        next_step: getRecommendedNextStep(progress),
    };
}

async function getOnboardingState(orgId, userId = null) {
    const [orgRes, keyRes, policyRes, integrationRes, decisionRes, userRes] = await Promise.all([
        db.query(
            `SELECT org_id, plan, plan_tier, subscription_status, account_type, onboarding_template
       FROM organizations
       WHERE org_id = $1`,
            [orgId],
            orgId
        ),
        db.query('SELECT COUNT(*) FROM api_keys WHERE org_id = $1', [orgId], orgId),
        db.query('SELECT COUNT(*) FROM policies WHERE org_id = $1', [orgId], orgId),
        db.query('SELECT COUNT(*) FROM integrations WHERE org_id = $1', [orgId], orgId),
        db.query('SELECT COUNT(*) FROM decisions WHERE org_id = $1', [orgId], orgId),
        userId
            ? db.query('SELECT user_id FROM users WHERE user_id = $1 AND org_id = $2', [userId, orgId], orgId)
            : Promise.resolve({ rows: [] }),
    ]);

    const org = orgRes.rows[0];
    const template = normalizeTemplate(org?.onboarding_template, org?.plan_tier || org?.plan);
    const progress = {
        account: userId ? userRes.rows.length > 0 : true,
        billing: ['trial_active', 'active'].includes(org?.subscription_status),
        api_key: Number.parseInt(keyRes.rows[0]?.count || 0, 10) > 0,
        policy: Number.parseInt(policyRes.rows[0]?.count || 0, 10) > 0,
        integration: Number.parseInt(integrationRes.rows[0]?.count || 0, 10) > 0,
        decision: Number.parseInt(decisionRes.rows[0]?.count || 0, 10) > 0,
    };

    return {
        template,
        template_label: getTemplateLabel(template),
        plan_tier: normalizePlanId(org?.plan_tier || org?.plan),
        account_type: org?.account_type || 'organization',
        progress,
        recommended_next_step: getRecommendedNextStep(progress),
        activation: getActivationState(template, progress),
        completed_steps: Object.values(progress).filter(Boolean).length,
        total_steps: Object.keys(progress).length,
    };
}

module.exports = {
    TEMPLATE_OPTIONS,
    getOnboardingState,
    normalizeTemplate,
};
