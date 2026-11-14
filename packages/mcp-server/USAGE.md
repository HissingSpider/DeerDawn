# Deerdawn MCP Server - Usage Guide

DeerDawn is AI session memory — your AI's chief of staff. It keeps the brief your AI reads before every session, so no new session starts cold. This guide covers configuring the server and the worked examples below.

## Quick Start

### 1. Use the auto-updating package entrypoint

No global install required. Configure your MCP host to launch:

```bash
npx -y @deerdawn/mcp-server@latest
```

### 2. Configure your coding agent

Add to your agent's MCP config (see README.md for agent-specific paths):

```json
{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com",
        "DEERDAWN_API_KEY": "dd_prod_your_key_here",
        "DEERDAWN_ORG_ID": "org-abc123"
      }
    }
  }
}
```

Supported agents: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code (Copilot/Continue), Zed.

### 3. Restart your editor

The Deerdawn tools, resources, and prompts will now be available.

## Common Workflows

### Workflow 1: Debug a Denied Decision

**Scenario**: A user's payment was denied and you need to understand why.

1. Find the decision ID from your logs or dashboard
2. In Claude Desktop:

```
Debug decision dec-abc123
```

Claude will:
- Fetch the decision details
- Identify which policy matched (or didn't match)
- Explain the conditions that were evaluated
- Suggest potential fixes

**Example Output**:
```markdown
# Decision Debug Analysis: dec-abc123

## Decision Outcome
- Result: DENY
- Reason: Payment amount exceeds threshold
- Policy: "High Value Payment Restrictions"

## Analysis
The decision was denied because the payment amount ($15,000) exceeded
the threshold ($10,000) defined in your fraud prevention policy.

## Recommendations
- Verify this is a legitimate high-value payment
- Consider increasing the threshold for trusted customers
- Add an exception for verified accounts
```

### Workflow 2: Create a New Policy

**Scenario**: You want to require 2FA for sensitive actions.

1. In your AI coding agent:

```
Help me create a policy to require 2FA for sensitive actions
```

Claude will:
- Show available templates
- Help you define conditions
- Create the policy via the API

**Example Interaction**:
```
You: "Create a policy to require 2FA for user deletions"

Claude: "I'll help you create that policy. Here's what I recommend:

Name: "Require 2FA for User Deletions"
Action Types: ["user.delete"]
Conditions:
  - Field: actor.has_2fa
  - Operator: eq
  - Value: false
Effect: deny

This will deny user deletion attempts from accounts without 2FA enabled.
Should I create this policy?"

You: "Yes, create it"

Claude: [Creates policy via create_policy tool]
"✓ Policy created successfully (pol-xyz789)"
```

### Workflow 3: Review Escalations Queue

**Scenario**: You have pending escalations that need review.

1. In your AI coding agent:

```
Review pending escalations
```

Claude will:
- List all pending escalations
- Group them by action type
- Show decision context
- Help you bulk approve/deny

**Example Output**:
```markdown
# Escalation Queue Review

## Summary
- Total Pending: 12
- Showing: 10 most recent

### By Action Type
- payment.process: 8
- data.export: 3
- user.delete: 1

## Pending Escalations

### 1. esc-123
- Action Type: payment.process
- Summary: High-value payment from new customer
- Amount: $25,000
- Created: 2 hours ago

You can approve, deny, or create a policy for similar cases.
```

### Workflow 4: Analyze Decision Patterns

**Scenario**: You want to understand how your policies are performing.

1. In your AI coding agent:

```
Analyze decision patterns for the last 7 days
```

Claude will:
- Fetch decision statistics
- Identify trends and anomalies
- Generate recommendations

**Example Output**:
```markdown
# Decision Pattern Analysis

## Overall Statistics
- Total Decisions: 1,247
- Allow Rate: 85%
- Deny Rate: 10%
- Escalation Rate: 5%

## Anomalies Detected
- High deny rate for payment.process (25%)
- Spike in escalations during business hours
- Average latency: 45ms (normal)

## Recommendations
- Review payment policies - may be too restrictive
- Create auto-approval rules for common escalations
- Consider caching for frequently evaluated actions
```

### Workflow 5: Generate Compliance Report

**Scenario**: You need a compliance audit report for your security team.

1. In your AI coding agent:

```
Generate a compliance report for last month
```

Claude will:
- Analyze policies and decisions
- Check security settings
- Generate a comprehensive audit report

**Example Output**:
```markdown
# Deerdawn Compliance Report

## Organization Settings
- Organization: Acme Corp (org-abc123)
- Plan: Enterprise
- Fail Mode: closed (secure)
- Redaction Mode: strict

## Compliance Checks
✓ High-Risk Action Coverage
✓ Secure Fail Mode
✓ PII Redaction
✓ Decision Audit Trail
✓ Policy Versioning

## Security Posture Score
100/100

All compliance requirements met.
```

## Advanced Usage

### Using Resources

Resources provide read-only access to aggregated data:

```
Show me my current policies
[Claude fetches deerdawn://policies/current resource]

Show me recent decisions
[Claude fetches deerdawn://decisions/recent resource]

What policy templates are available?
[Claude fetches deerdawn://templates/all resource]
```

### Direct Tool Usage

You can also call tools directly:

```
Evaluate a decision for action type "payment.process" with amount $5000

Create a new policy called "Fraud Detection" for payment.process
that escalates payments over $10,000

List all escalations with status "pending"

Update organization fail mode to "closed"
```

### Combining Tools

Claude can combine multiple tools to accomplish complex tasks:

```
You: "Find all denied payments in the last week and create a policy
to auto-approve similar legitimate cases"

Claude:
1. Calls list_decisions with filters
2. Analyzes denied payment patterns
3. Suggests a new policy
4. Creates the policy via create_policy
```

## Tips and Best Practices

### 1. Use Descriptive Trace IDs

When evaluating decisions, use trace IDs that help you debug later:

```javascript
{
  trace_id: "payment-user123-20240115-001",
  action_type: "payment.process",
  ...
}
```

### 2. Test in Sandbox First

Always test new policies in sandbox environment:

```
Create a policy in sandbox environment for testing
```

### 3. Monitor Escalations Regularly

Set up a daily routine to review escalations:

```
Review escalations (daily at 9am)
```

### 4. Use Templates

Leverage built-in templates for common use cases:

```
Show me fraud detection templates

Create a policy from the "fraud-detection-basic" template
```

### 5. Keep Policies Organized

Use clear names and descriptions:

```
Create a policy called "Require KYC for High-Value Payments"
with description "Escalate payments >$10k from unverified users"
```

## Troubleshooting

### "Authentication failed"

Check your API key is correctly set in Claude Desktop config:
```json
"DEERDAWN_API_KEY": "dd_prod_your_actual_key"
```

### "Resource not found"

Ensure the decision/policy/escalation ID is correct:
```
Get decision details for dec-abc123
(not: decision-abc123 or dec_abc123)
```

### Slow responses

Enable caching and reduce result limits:
```json
"DEERDAWN_CACHE_ENABLED": "true",
"DEERDAWN_CACHE_TTL_SECONDS": "60"
```

### Tools not showing up

1. Restart your editor after saving the config file
2. Check MCP logs (location varies by agent — see README Troubleshooting section)
3. Verify the server runs: `npx -y @deerdawn/mcp-server@latest` (should print config loaded message)

## Getting Help

- Ask Claude: "What Deerdawn tools are available?"
- Check docs: https://docs.deerdawn.com
- Join Discord: https://discord.gg/deerdawn
