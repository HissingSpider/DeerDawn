-- Check Signup State for Recent Users
-- Run this after a test signup to verify everything was created correctly

-- Recent organizations (last 24 hours)
SELECT
    o.org_id,
    o.name,
    o.account_type,
    o.plan,
    o.subscription_status,
    o.stripe_customer_id,
    o.stripe_subscription_id,
    o.trial_ends_at,
    o.created_at,
    CASE
        WHEN o.subscription_status = 'active' THEN 'Active'
        WHEN o.subscription_status = 'trial_active' THEN 'Trial Active'
        WHEN o.subscription_status = 'cancelled' THEN 'Cancelled'
        ELSE '' || o.subscription_status
    END as status_emoji
FROM organizations o
WHERE o.created_at > NOW() - INTERVAL '24 hours'
ORDER BY o.created_at DESC
LIMIT 10;

-- Recent users with their org info
SELECT
    u.user_id,
    u.email,
    u.role,
    u.auth_provider,
    o.org_id,
    o.name as org_name,
    o.account_type,
    o.plan,
    o.subscription_status,
    u.created_at
FROM users u
JOIN organizations o ON u.org_id = o.org_id
WHERE u.created_at > NOW() - INTERVAL '24 hours'
ORDER BY u.created_at DESC
LIMIT 10;

-- Recent API keys (should be auto-generated for new signups)
SELECT
    k.key_id,
    k.prefix,
    k.name,
    k.environment,
    k.org_id,
    o.name as org_name,
    k.status,
    k.expires_at,
    k.created_at,
    CASE
        WHEN k.expires_at < NOW() THEN 'Expired'
        WHEN k.status = 'active' THEN 'Active'
        ELSE '' || k.status
    END as status_emoji
FROM api_keys k
JOIN organizations o ON k.org_id = o.org_id
WHERE k.created_at > NOW() - INTERVAL '24 hours'
ORDER BY k.created_at DESC
LIMIT 10;

-- Check for orphaned records (users without orgs, keys without orgs)
SELECT
    'Orphaned Users' as issue_type,
    COUNT(*) as count
FROM users u
LEFT JOIN organizations o ON u.org_id = o.org_id
WHERE o.org_id IS NULL

UNION ALL

SELECT
    'Orphaned API Keys' as issue_type,
    COUNT(*) as count
FROM api_keys k
LEFT JOIN organizations o ON k.org_id = o.org_id
WHERE o.org_id IS NULL;

-- Recent decisions (to verify API is being used)
SELECT
    d.decision_id,
    d.org_id,
    o.name as org_name,
    d.action_type,
    d.decision,
    d.policy_id,
    d.created_at
FROM decisions d
JOIN organizations o ON d.org_id = o.org_id
WHERE d.created_at > NOW() - INTERVAL '1 hour'
ORDER BY d.created_at DESC
LIMIT 5;

-- Summary stats
SELECT
    'Total Organizations' as metric,
    COUNT(*) as value
FROM organizations

UNION ALL

SELECT
    'Active Subscriptions' as metric,
    COUNT(*) as value
FROM organizations
WHERE subscription_status = 'active'

UNION ALL

SELECT
    'Trial Accounts' as metric,
    COUNT(*) as value
FROM organizations
WHERE subscription_status = 'trial_active'

UNION ALL

SELECT
    'Personal Accounts' as metric,
    COUNT(*) as value
FROM organizations
WHERE account_type = 'personal'

UNION ALL

SELECT
    'Organization Accounts' as metric,
    COUNT(*) as value
FROM organizations
WHERE account_type = 'organization'

UNION ALL

SELECT
    'Total Users' as metric,
    COUNT(*) as value
FROM users

UNION ALL

SELECT
    'Active API Keys' as metric,
    COUNT(*) as value
FROM api_keys
WHERE status = 'active' AND expires_at > NOW();

-- Check for common issues
SELECT
    'Organizations with no users' as potential_issue,
    COUNT(*) as count
FROM organizations o
LEFT JOIN users u ON o.org_id = u.org_id
WHERE u.user_id IS NULL

UNION ALL

SELECT
    'Organizations with no API keys' as potential_issue,
    COUNT(*) as count
FROM organizations o
LEFT JOIN api_keys k ON o.org_id = k.org_id
WHERE k.key_id IS NULL AND o.created_at > NOW() - INTERVAL '24 hours'

UNION ALL

SELECT
    'Active subscriptions without Stripe customer ID' as potential_issue,
    COUNT(*) as count
FROM organizations
WHERE subscription_status = 'active' AND stripe_customer_id IS NULL

UNION ALL

SELECT
    'Active subscriptions without Stripe subscription ID' as potential_issue,
    COUNT(*) as count
FROM organizations
WHERE subscription_status = 'active' AND stripe_subscription_id IS NULL;
