// Core types for Deerdawn API interactions

/** Normalized from GET /api/v1/orgs/usage for prompts and tools. */
export interface OrganizationSettings {
  org_id: string;
  name: string;
  plan: string;
  fail_mode: 'open' | 'closed';
  redaction_mode: 'strict' | 'permissive';
  is_locked: boolean;
  shadow_mode?: boolean;
  redaction_keys?: string[];
  created_at: string;
  usage?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

/** Matches audit_logs rows from the API. */
export interface AuditLog {
  log_id: string;
  org_id: string;
  actor: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
  created_at: string;
}

export interface ActionTypeDefinition {
  action_type: string;
  category: string;
  description: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  required_fields?: string[];
  examples?: string[];
}
