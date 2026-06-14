export type Channel =
  | "fax_referral"
  | "voicemail_transcript"
  | "portal_message"
  | "email";

export type Discipline = "SLP" | "OT" | "PT";

export type Classification =
  | "new_referral"
  | "existing_patient_request"
  | "scheduling"
  | "clinical_question"
  | "billing_question"
  | "missing_paperwork"
  | "provider_followup"
  | "complaint"
  | "safeguarding"
  | "spam"
  | "other";

export type Urgency = "P0" | "P1" | "P2" | "P3";

export type PolicyTopic =
  | "service_lines"
  | "insurance"
  | "safeguarding"
  | "clinical_advice"
  | "scheduling"
  | "cancellation"
  | "language_access";

export type Assignee = "front_desk" | "intake" | "billing" | "clinical_lead";

export interface InboxItem {
  id: string;
  channel: Channel;
  received_at: string;
  sender: string;
  subject: string;
  body: string;
  attachments: string[];
}

export interface ToolCall {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  result_summary: string;
}

export interface TraceEntry extends ToolCall {
  item_id?: string;
  timestamp: string;
  audit_exempt?: "retry" | "batch_setup" | "validator_probe";
}

export interface ToolResult<T> extends ToolCall {
  data: T;
}

export interface ExtractedIntake {
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: Discipline[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
}

export interface ItemOutput {
  item_id: string;
  classification: Classification;
  urgency: Urgency;
  requires_human_review: boolean;
  extracted_intake: ExtractedIntake;
  missing_info: string[];
  tools_called: ToolCall[];
  recommended_next_action: string;
  draft_reply: string | null;
  task_ids: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  decision_rationale: string;
}

export interface BatchOutput {
  generated_at: string;
  summary: {
    total_items: number;
    p0_count: number;
    p1_count: number;
    requires_human_review_count: number;
  };
  items: ItemOutput[];
}

export interface Patient {
  patient_id: string;
  name: string;
  dob: string;
  guardian_name: string;
  status: "active" | "inactive";
}

export interface Provider {
  provider_id: string;
  name: string;
  discipline: Discipline;
  languages: string[];
  age_range: string;
  caseload_status: "accepting" | "limited" | "full";
  next_available_slots: Array<{
    slot_id: string;
    start: string;
    appointment_type: string;
  }>;
}

export interface Slot {
  slot_id: string;
  provider_id: string;
  provider_name: string;
  discipline: Discipline;
  start: string;
  appointment_type: string;
  languages: string[];
}
