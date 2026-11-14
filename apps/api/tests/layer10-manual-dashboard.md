# Layer 10 — Manual Dashboard Checklist

Complete these manually in a browser before launch. Check each item and note any issues.

---

## Prerequisites

- API server running at `http://localhost:8080` (or production URL)
- Dashboard running at `http://localhost:3000` (or `app.deerdawn.com`)
- Stripe test mode enabled
- Test cards ready:
  - **Success:** `4242 4242 4242 4242` (any future expiry, any CVC)
  - **Decline:** `4000 0000 0000 0002`
  - **Payment failed:** `4000 0000 0000 0341`

---

## Authentication Flow

- [ ] `/signup` page loads without JS errors
- [ ] Clerk modal appears on click of "Sign Up"
- [ ] Email entered → verification code sent to inbox
- [ ] Verification code accepted → user redirected to app
- [ ] `/login` page loads and works with existing account
- [ ] Logout works and clears session

---

## Plan Selection

- [ ] `/select-plan` page loads showing personal and org tiers
- [ ] Personal pricing matches advertised self-serve amounts (Free / Pro $10)
- [ ] "Get Started" button on free tier → bypasses checkout → lands on dashboard
- [ ] "Upgrade" on paid tier → redirects to Stripe checkout
- [ ] Plan page shows correct account type (personal vs org)

---

## Stripe Checkout

- [ ] Stripe checkout page loads with correct plan name and price
- [ ] Test card `4242 4242 4242 4242` — payment succeeds
- [ ] Post-payment redirect lands back on dashboard (not 404)
- [ ] Dashboard shows correct upgraded plan after payment
- [ ] `Settings > Plan` shows plan name, renewal date, usage meters
- [ ] Test card `4000 0000 0000 0002` — shows "card declined" message gracefully

---

## API Key Management

- [ ] `Settings > API Keys` page loads
- [ ] "Create Key" generates new key and shows plaintext ONCE in modal
- [ ] Plaintext key starts with `dd_`
- [ ] Copy button copies key to clipboard
- [ ] Key appears in list in masked form after creation
- [ ] "Delete" / "Revoke" button removes key from list
- [ ] Deleted key no longer works in API requests

---

## Dashboard — Context Workspace

- [ ] `/context/workspace` (or equivalent) page loads without error
- [ ] Project list renders (or shows "no projects" empty state)
- [ ] Clicking a project shows context brief on right panel
- [ ] Context brief shows: task, status, tech_stack, decisions, open_questions
- [ ] Knowledge graph visualization renders (if projects with entities exist)
- [ ] "Add Project" button opens creation flow
- [ ] New project appears in list immediately after creation

---

## Import Flow

- [ ] `/context/import` page loads
- [ ] Upload / paste a CLAUDE.md file triggers preview
- [ ] Preview shows extracted fields (task, status, stack, decisions)
- [ ] "Confirm Import" button creates/updates project
- [ ] Success message shown with project_id
- [ ] Project appears in workspace list after import

---

## Billing Portal

- [ ] `Settings > Plan` shows "Manage Subscription" link
- [ ] Clicking link opens Stripe billing portal in new tab
- [ ] Portal shows current plan and subscription details
- [ ] "Cancel Subscription" in portal → subscription canceled
- [ ] After cancellation: dashboard shows downgrade to free plan
- [ ] Failed payment `4000 0000 0000 0341` → dashboard shows payment failed banner

---

## MCP Auth Flow (Browser Side)

- [ ] Navigate to `http://localhost:3000/mcp-auth?code=<test_device_code>` (from `POST /api/v1/auth/mcp/start`)
- [ ] Page shows "Authorize DeerDawn MCP" prompt
- [ ] Clicking "Authorize" returns success message
- [ ] MCP token poll endpoint returns api_key after browser authorization

---

## Desktop App Auth Handoff

- [ ] Navigate to `http://localhost:3000/desktop-auth`
- [ ] Page shows desktop auth handoff
- [ ] `deerdawn://auth?code=...` deep link triggers desktop app (if installed)

---

## Responsive + Accessibility

- [ ] Dashboard works at 1280px width (desktop)
- [ ] Dashboard works at 768px width (tablet)
- [ ] No console errors on any page
- [ ] All interactive elements focusable via keyboard
- [ ] Page titles are descriptive (not blank)

---

## Notes

_Record any issues found during manual testing:_

| Page | Issue | Severity | Status |
|------|-------|----------|--------|
|      |       |          |        |
