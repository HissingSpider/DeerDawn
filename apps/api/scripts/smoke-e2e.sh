#!/bin/bash
set -e

API_URL=${1:-"https://api.deerdawn.com"}
DASHBOARD_URL=${2:-"https://app.deerdawn.com"}

echo "Starting Smoke E2E Test against API: $API_URL"

# 1. Create User (Admin) - Use Timestamp + Random to ensure uniqueness
RANDOM_SUFFIX=$((RANDOM % 1000))
EMAIL="smoke-test-$(date +%s)-${RANDOM_SUFFIX}@deerdawn.com"
PASSWORD="password123"
echo "Creating user: $EMAIL"

# Call signup ONCE and capture output
RESPONSE=$(curl -s -X POST "$API_URL/api/v1/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\", \"password\":\"$PASSWORD\"}")

# Extract token
TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^" ]*"' | cut -d'"' -f4)

# If no token, check if it was an error
if [ -z "$TOKEN" ]; then
    echo "Signup didn't return a token. Checking for 'User exists'..."
    if [[ "$RESPONSE" == *"User exists"* ]]; then
        echo "ℹ️ User already exists, attempting login..."
        RESPONSE=$(curl -s -X POST "$API_URL/api/v1/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"$EMAIL\", \"password\":\"$PASSWORD\"}")
        TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^" ]*"' | cut -d'"' -f4)
    fi
fi

if [ -z "$TOKEN" ]; then
  echo "Auth failed. Response: $RESPONSE"
  exit 1
fi
echo "Auth successful. Token acquired."

# 2. Verify Onboarding State
echo "Fetching onboarding state..."
ONBOARDING_RES=$(curl -s -X GET "$API_URL/api/v1/onboarding/state" \
  -H "Authorization: Bearer $TOKEN")

if [[ "$ONBOARDING_RES" != *"recommended_next_step"* ]]; then
  echo "Onboarding state failed. Response: $ONBOARDING_RES"
  exit 1
fi
echo "Onboarding state returned."

# 3. Verify Dashboard Bootstrap
echo "Fetching dashboard bootstrap..."
BOOTSTRAP_RES=$(curl -s -X GET "$API_URL/api/v1/dashboard/bootstrap" \
  -H "Authorization: Bearer $TOKEN")

if [[ "$BOOTSTRAP_RES" != *"\"status\":\"ok\""* ]] || [[ "$BOOTSTRAP_RES" != *"visible_navigation"* ]]; then
  echo "Dashboard bootstrap failed. Response: $BOOTSTRAP_RES"
  exit 1
fi
echo "Dashboard bootstrap returned."

# 4. Create a starter policy from template
echo "Creating policy from template..."
POLICY_RES=$(curl -s -X POST "$API_URL/api/v1/policies/from-template" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template_id":"refund_auto_approve","environment":"production","customizations":{"name":"Smoke Refund Auto Approve","reason":"Smoke test policy bootstrap","enabled":true}}')

POLICY_ID=$(echo $POLICY_RES | grep -o '"policy_id":"[^" ]*"' | cut -d'"' -f4)

if [ -z "$POLICY_ID" ]; then
  echo "Policy template creation failed. Response: $POLICY_RES"
  exit 1
fi
echo "Policy created: $POLICY_ID"

# 5. Create API Key
echo "Creating API Key..."
KEY_RES=$(curl -s -X POST "$API_URL/api/v1/keys" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test Key", "environment":"production"}')

API_KEY=$(echo $KEY_RES | grep -o '"key":"[^" ]*"' | cut -d'"' -f4)

if [ -z "$API_KEY" ]; then
  echo "Key creation failed. Response: $KEY_RES"
  exit 1
fi
echo "API Key created: ${API_KEY:0:10}..."

# 6. Call Decision API
TRACE_ID="smoke-trace-$(date +%s)-${RANDOM_SUFFIX}"
echo "Calling Decision API (Trace: $TRACE_ID)..."

DECISION_RES=$(curl -s -X POST "$API_URL/api/v1/decisions:evaluate" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"action_type\":\"refund.approve\",\"trace_id\":\"$TRACE_ID\",\"payload\":{\"amount\":100}}")

DECISION=$(echo $DECISION_RES | grep -o '"decision":"[^" ]*"' | cut -d'"' -f4)

if [ "$DECISION" != "allow" ] && [ "$DECISION" != "deny" ] && [ "$DECISION" != "escalate" ]; then
  echo "Decision call failed. Response: $DECISION_RES"
  exit 1
fi
echo "Decision received: $DECISION"

# 7. Verify Decision Log (via API)
echo "Verifying decision log entry..."
# Allow DB consistency delay
sleep 2

DECISIONS_RES=$(curl -s -X GET "$API_URL/api/v1/decisions?trace_id=$TRACE_ID" \
  -H "Authorization: Bearer $TOKEN")

# Simple check: does decision list contain our trace id?
if [[ "$DECISIONS_RES" == *"$TRACE_ID"* ]]; then
  echo "Decision verification passed."
else
  echo "Decision verification failed. Response: $DECISIONS_RES"
  exit 1
fi

# 8. Verify billing plans surface
echo "Checking billing plans..."
BILLING_RES=$(curl -s -X GET "$API_URL/api/v1/billing/plans" \
  -H "Authorization: Bearer $TOKEN")

if [[ "$BILLING_RES" != *"starter"* ]] || [[ "$BILLING_RES" != *"growth"* ]]; then
  echo "Billing plans check failed. Response: $BILLING_RES"
  exit 1
fi
echo "Billing plans returned."

echo "E2E SMOKE TEST PASSED!"
exit 0
