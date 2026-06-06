/**
 * onboarding/types.ts
 *
 * Shared TypeScript interfaces used by the provisioner, API routes,
 * and MCP server. No runtime code — types only.
 */

/** Raw body sent by the HRIS webhook. */
export interface WebhookPayload {
  event_id: string;
  event_type: string;
  email: string;
  full_name: string;
  role: string;
}

/** Successful provisioning response (202 Accepted). */
export interface ProvisioningResult {
  event_id: string;
  status: 'completed';
  idempotent: boolean;
  employee: {
    email: string;
    role: string;
  };
  granted_apps: string[];
}

/** Error response body (400 / 409). */
export interface ProvisioningError {
  event_id: string;
  error: string;
  message: string;
}

/** Row shape from the `employees` table. */
export interface Employee {
  id: number;
  email: string;
  full_name: string;
  role: string;
  created_at: string;
}

/** Row shape from the `access_grants` table. */
export interface AccessGrant {
  employee_email: string;
  app_name: string;
  granted_at: string;
}

/** Row shape from the `audit_log` table. */
export interface AuditLogEntry {
  event_id: string;
  action: 'provisioned' | 'idempotent_skip' | 'failed';
  details_json: string;
  created_at: string;
}

/** Row shape from the `webhook_events` table. */
export interface WebhookEvent {
  event_id: string;
  payload_json: string;
  status: 'pending' | 'completed' | 'failed';
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
