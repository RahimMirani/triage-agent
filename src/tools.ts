import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { ulid } from "ulid";
import type {
  Assignee,
  BatchOutput,
  Discipline,
  ItemOutput,
  Patient,
  PolicyTopic,
  Provider,
  Slot,
  ToolCall,
  ToolResult,
  TraceEntry,
} from "./types.js";

const itemContext = new AsyncLocalStorage<string>();

let tracePath: string | null = null;
let traceEntries: TraceEntry[] = [];

export function configureTrace(config: { path: string }): void {
  tracePath = resolve(process.cwd(), config.path);
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, "");
  traceEntries = [];
}

export async function withItemContext<T>(
  itemId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return itemContext.run(itemId, fn);
}

export function getToolCallsForItem(itemId: string): ToolCall[] {
  return traceEntries
    .filter((entry) => entry.item_id === itemId && !entry.audit_exempt)
    .map(({ call_id, name, args, result_summary }) => ({
      call_id,
      name,
      args: clone(args),
      result_summary,
    }));
}

export function buildBatchOutput(items: ItemOutput[]): BatchOutput {
  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_items: items.length,
      p0_count: items.filter((item) => item.urgency === "P0").length,
      p1_count: items.filter((item) => item.urgency === "P1").length,
      requires_human_review_count: items.filter(
        (item) => item.requires_human_review,
      ).length,
    },
    items,
  };
}

export async function search_patient(args: {
  name?: string;
  dob?: string;
}): Promise<ToolResult<Patient[]>> {
  const name = normalize(args.name);
  const patients: Patient[] = [];

  if (args.dob === "2019-03-15" && name.includes("mateo")) {
    patients.push({
      patient_id: "pat_mateo_ramirez_jr",
      name: "Mateo Ramirez Jr.",
      dob: "2019-03-15",
      guardian_name: "Sofia Ramirez",
      status: "active",
    });
  }

  if (
    (args.dob === "2017-11-02" && name.includes("noah")) ||
    name.includes("noah patel")
  ) {
    patients.push({
      patient_id: "pat_noah_patel",
      name: "Noah Patel",
      dob: "2017-11-02",
      guardian_name: "Anita Patel",
      status: "active",
    });
  }

  const resultSummary =
    patients.length === 0
      ? "0 patient matches"
      : `${patients.length} patient match${
          patients.length === 1 ? "" : "es"
        }: ${patients.map((patient) => `${patient.name} (${patient.dob})`).join(", ")}`;

  return recordTool("search_patient", args, patients, resultSummary);
}

export async function verify_insurance(args: {
  payer?: string;
  member_id?: string;
}): Promise<
  ToolResult<{
    status: "in_network" | "out_of_network" | "expired" | "unknown";
    plan?: string;
    copay?: number;
    auth_required?: boolean;
    notes?: string;
  }>
> {
  const payer = normalize(args.payer);
  const data = (() => {
    if (!payer) {
      return {
        status: "unknown" as const,
        notes: "No payer was provided for verification.",
      };
    }

    if (
      payer.includes("sunrise") ||
      payer.includes("pediatric choice") ||
      payer.includes("community first")
    ) {
      return {
        status: "expired" as const,
        plan: args.payer,
        notes:
          "Billing system shows this coverage expired; referral document may be stale.",
      };
    }

    if (
      payer.includes("kaiser") ||
      payer.includes("cigna select") ||
      payer.includes("beacon")
    ) {
      return {
        status: "out_of_network" as const,
        plan: args.payer,
        auth_required: false,
        notes:
          "Payer is not in network for Cedar Kids Therapy; benefits conversation required.",
      };
    }

    if (
      payer.includes("aetna") ||
      payer.includes("blue cross") ||
      payer.includes("bluecross") ||
      payer.includes("bcbs") ||
      payer.includes("united") ||
      payer.includes("uhc") ||
      payer.includes("medicaid")
    ) {
      return {
        status: "in_network" as const,
        plan: args.payer,
        copay: payer.includes("medicaid") ? 0 : 30,
        auth_required: !payer.includes("medicaid"),
        notes: "Verified active in-network coverage.",
      };
    }

    return {
      status: "unknown" as const,
      plan: args.payer,
      notes: "Payer was not recognized by the mock billing system.",
    };
  })();

  return recordTool(
    "verify_insurance",
    args,
    data,
    `insurance status: ${data.status}${data.plan ? ` (${data.plan})` : ""}`,
  );
}

export async function lookup_policy(args: {
  topic: PolicyTopic;
}): Promise<ToolResult<{ snippets: string[] }>> {
  const snippets = policySnippets[args.topic];
  return recordTool(
    "lookup_policy",
    args,
    { snippets },
    `${snippets.length} policy snippets for ${args.topic}`,
  );
}

export async function find_slots(args: {
  discipline?: Discipline;
  preferences?: string;
  language?: string;
}): Promise<ToolResult<Slot[]>> {
  const language = normalize(args.language || "en");
  const providers = readProviders();
  const slots = providers
    .filter((provider) => provider.caseload_status !== "full")
    .filter((provider) =>
      args.discipline ? provider.discipline === args.discipline : true,
    )
    .filter((provider) =>
      args.language
        ? provider.languages.map(normalize).includes(language)
        : true,
    )
    .flatMap((provider) =>
      provider.next_available_slots.map((slot) => ({
        slot_id: slot.slot_id,
        provider_id: provider.provider_id,
        provider_name: provider.name,
        discipline: provider.discipline,
        start: slot.start,
        appointment_type: slot.appointment_type,
        languages: provider.languages,
      })),
    )
    .slice(0, 5);

  const first = slots[0];
  const resultSummary = first
    ? `${slots.length} matching slots; earliest ${first.start} with ${first.provider_name}`
    : "0 matching slots";

  return recordTool("find_slots", args, slots, resultSummary);
}

export async function hold_slot(args: {
  slot_id: string;
  patient_ref: string;
}): Promise<
  ToolResult<{
    hold_id: string;
    status: "pending_review";
    expires_at: string;
  }>
> {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const data = {
    hold_id: `hold_${shortId()}`,
    status: "pending_review" as const,
    expires_at: expiresAt,
  };

  return recordTool(
    "hold_slot",
    args,
    data,
    `created pending_review hold ${data.hold_id} until ${expiresAt}`,
  );
}

export async function create_task(args: {
  assignee: Assignee;
  title: string;
  due: string;
  notes: string;
}): Promise<ToolResult<{ task_id: string }>> {
  const data = { task_id: `task_${shortId()}` };
  return recordTool(
    "create_task",
    args,
    data,
    `created task ${data.task_id} for ${args.assignee}`,
  );
}

export async function draft_message(args: {
  recipient: string;
  channel: "portal" | "email" | "phone";
  body: string;
  language?: "en" | "es";
}): Promise<ToolResult<{ draft_id: string; status: "draft" }>> {
  const data = { draft_id: `draft_${shortId()}`, status: "draft" as const };
  const language = args.language || "en";
  return recordTool(
    "draft_message",
    args,
    data,
    `created draft ${data.draft_id} (${args.channel}, ${language})`,
  );
}

export async function escalate(args: {
  item_id: string;
  reason: string;
  severity: "P0" | "P1";
}): Promise<ToolResult<{ escalation_id: string }>> {
  const data = { escalation_id: `esc_${shortId()}` };
  return recordTool(
    "escalate",
    args,
    data,
    `created escalation ${data.escalation_id} severity ${args.severity}`,
  );
}

function recordTool<T>(
  name: string,
  args: Record<string, unknown>,
  data: T,
  resultSummary: string,
): ToolResult<T> {
  if (!tracePath) {
    throw new Error(
      "TraceNotConfigured: src/index.ts must call configureTrace before tool use.",
    );
  }

  const itemId = itemContext.getStore();
  if (!itemId) {
    throw new Error(
      `ToolCallOutsideItemContext: ${name} must be called inside withItemContext(item.id, ...)`,
    );
  }

  const call_id = ulid();
  const cleanArgs = canonicalize(args) as Record<string, unknown>;
  const entry: TraceEntry = {
    call_id,
    item_id: itemId,
    name,
    args: cleanArgs,
    result_summary: resultSummary,
    timestamp: new Date().toISOString(),
  };

  traceEntries.push(entry);
  appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);

  return {
    call_id,
    name,
    args: clone(cleanArgs),
    result_summary: resultSummary,
    data,
  };
}

function readProviders(): Provider[] {
  const providersPath = resolve(process.cwd(), "data/providers.json");
  if (!existsSync(providersPath)) {
    return [];
  }

  return JSON.parse(readFileSync(providersPath, "utf8")) as Provider[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }

  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalize(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function shortId(): string {
  return ulid().toLowerCase();
}

// KEEP IN SYNC with data/policies.md — snippets are hardcoded for deterministic
// stub behavior. If you edit policies.md, mirror the change here.
const policySnippets: Record<PolicyTopic, string[]> = {
  service_lines: [
    "Cedar Kids Therapy serves children ages 0-18 for speech-language pathology (SLP), occupational therapy (OT), and physical therapy (PT).",
    "Intake should confirm the requested discipline before scheduling an evaluation.",
  ],
  insurance: [
    "In-network payers include Aetna, Blue Cross Blue Shield, UnitedHealthcare, and Medicaid.",
    "Out-of-network payers require a benefits conversation before any slot is held.",
    "Verified status from billing systems supersedes payer information on referral documents. When they conflict, trust the system of record and surface the discrepancy.",
  ],
  safeguarding: [
    "Any disclosure suggesting harm, abuse, neglect, or unsafe caregiving is P0 and must be escalated to the clinical lead immediately.",
    "Do not provide investigative advice in an outbound message; draft only a neutral acknowledgement for staff review.",
  ],
  clinical_advice: [
    "Front desk staff and automated systems must not provide clinical advice over message.",
    "Clinical questions should be routed to evaluation, screening, or clinician review.",
  ],
  scheduling: [
    "Same-day cancellations or reschedules are P1 operational issues.",
    "Agents may recommend or hold slots for human review but must not schedule appointments.",
  ],
  cancellation: [
    "Families should notify the office as soon as possible for same-day cancellation or illness.",
    "Makeup availability depends on provider capacity and must be reviewed by staff.",
  ],
  language_access: [
    "Families may request communication in Spanish.",
    "When possible, match Spanish-speaking families with Spanish-capable staff or providers.",
  ],
};
