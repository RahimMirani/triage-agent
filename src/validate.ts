import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { BatchOutput, InboxItem, ToolCall, TraceEntry } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  compile: (
    schema: Record<string, unknown>,
  ) => ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> };
};
const addFormats = require("ajv-formats") as (ajv: InstanceType<typeof Ajv>) => void;

interface CliArgs {
  input: string;
  output: string;
  trace: string;
}

const forbiddenTools = new Set(["schedule_appointment", "send_message"]);

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const errors: string[] = [];

  const input = readJson<InboxItem[]>(args.input, errors, "input");
  const output = readJson<BatchOutput>(args.output, errors, "output");
  const schema = readJson<Record<string, unknown>>(
    "schema/output.schema.json",
    errors,
    "schema",
  );
  const trace = readTrace(args.trace, errors);

  if (!input || !output || !schema) {
    fail(errors);
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(output)) {
    for (const error of validate.errors || []) {
      errors.push(
        `schema: ${error.instancePath || "/"} ${error.message || "is invalid"}`,
      );
    }
  }

  validateItemCoverage(input, output, errors);
  validateSummary(output, errors);
  validateHumanReview(output, errors);
  validateToolThreshold(output, errors);
  validateForbiddenTools(output, trace, errors);
  validateTraceMatch(output, trace, errors);

  if (errors.length > 0) {
    fail(errors);
  }

  console.log("Validation passed.");
}

function validateItemCoverage(
  input: InboxItem[],
  output: BatchOutput,
  errors: string[],
): void {
  const inputIds = new Set(input.map((item) => item.id));
  const counts = new Map<string, number>();

  for (const item of output.items) {
    counts.set(item.item_id, (counts.get(item.item_id) || 0) + 1);
    if (!inputIds.has(item.item_id)) {
      errors.push(`item coverage: output contains unknown item_id ${item.item_id}`);
    }
  }

  for (const id of inputIds) {
    const count = counts.get(id) || 0;
    if (count === 0) {
      errors.push(`item coverage: missing output for ${id}`);
    } else if (count > 1) {
      errors.push(`item coverage: duplicate output for ${id}`);
    }
  }
}

function validateSummary(output: BatchOutput, errors: string[]): void {
  const expected = {
    total_items: output.items.length,
    p0_count: output.items.filter((item) => item.urgency === "P0").length,
    p1_count: output.items.filter((item) => item.urgency === "P1").length,
    requires_human_review_count: output.items.filter(
      (item) => item.requires_human_review,
    ).length,
  };

  for (const [key, value] of Object.entries(expected)) {
    const actual = output.summary[key as keyof typeof output.summary];
    if (actual !== value) {
      errors.push(`summary: ${key} is ${actual}, expected ${value}`);
    }
  }
}

function validateHumanReview(output: BatchOutput, errors: string[]): void {
  for (const item of output.items) {
    if (item.requires_human_review !== true) {
      errors.push(
        `human review: ${item.item_id} must have requires_human_review=true`,
      );
    }
  }
}

function validateToolThreshold(output: BatchOutput, errors: string[]): void {
  const distinctToolNames = new Set<string>();
  for (const item of output.items) {
    for (const call of item.tools_called) {
      distinctToolNames.add(call.name);
    }
  }

  if (distinctToolNames.size < 3) {
    errors.push(
      `tool threshold: found ${distinctToolNames.size} distinct tool names, expected at least 3`,
    );
  }
}

function validateForbiddenTools(
  output: BatchOutput,
  trace: TraceEntry[],
  errors: string[],
): void {
  for (const item of output.items) {
    for (const call of item.tools_called) {
      if (forbiddenTools.has(call.name)) {
        errors.push(
          `forbidden tools: ${call.name} appears in output for ${item.item_id}`,
        );
      }
    }
  }

  for (const entry of trace) {
    if (forbiddenTools.has(entry.name)) {
      errors.push(`forbidden tools: ${entry.name} appears in trace`);
    }
  }
}

function validateTraceMatch(
  output: BatchOutput,
  trace: TraceEntry[],
  errors: string[],
): void {
  const traceById = new Map<string, TraceEntry>();
  for (const entry of trace) {
    if (traceById.has(entry.call_id)) {
      errors.push(`trace: duplicate call_id ${entry.call_id}`);
    }
    traceById.set(entry.call_id, entry);
  }

  const reportedById = new Map<
    string,
    Array<{ itemId: string; call: ToolCall }>
  >();
  for (const item of output.items) {
    for (const call of item.tools_called) {
      const reported = reportedById.get(call.call_id) || [];
      reported.push({ itemId: item.item_id, call });
      reportedById.set(call.call_id, reported);

      const traceEntry = traceById.get(call.call_id);
      if (!traceEntry) {
        errors.push(
          `trace match: ${item.item_id} reports unknown call_id ${call.call_id}`,
        );
        continue;
      }

      if (traceEntry.audit_exempt) {
        errors.push(
          `trace match: ${item.item_id} reports audit-exempt call_id ${call.call_id}`,
        );
      }

      if (traceEntry.item_id !== item.item_id) {
        errors.push(
          `trace match: ${call.call_id} belongs to ${traceEntry.item_id}, but output lists it under ${item.item_id}`,
        );
      }

      if (traceEntry.name !== call.name) {
        errors.push(
          `trace match: ${call.call_id} name is ${call.name}, expected ${traceEntry.name}`,
        );
      }

      if (canonicalString(traceEntry.args) !== canonicalString(call.args)) {
        errors.push(`trace match: ${call.call_id} args do not match trace`);
      }

      if (traceEntry.result_summary !== call.result_summary) {
        errors.push(
          `trace match: ${call.call_id} result_summary does not match trace`,
        );
      }
    }
  }

  for (const entry of trace) {
    if (entry.audit_exempt) {
      continue;
    }

    if (!entry.item_id) {
      errors.push(`trace: non-exempt call ${entry.call_id} has no item_id`);
    }

    const reports = reportedById.get(entry.call_id) || [];
    if (reports.length === 0) {
      errors.push(
        `trace match: non-exempt trace call ${entry.call_id} (${entry.name}) was not surfaced in output`,
      );
    } else if (reports.length > 1) {
      errors.push(
        `trace match: call_id ${entry.call_id} appears ${reports.length} times in output`,
      );
    }
  }
}

function readJson<T>(
  path: string,
  errors: string[],
  label: string,
): T | null {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as T;
  } catch (error) {
    errors.push(
      `${label}: failed to read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function readTrace(path: string, errors: string[]): TraceEntry[] {
  const fullPath = resolve(process.cwd(), path);
  if (!existsSync(fullPath)) {
    errors.push(`trace: file does not exist at ${path}`);
    return [];
  }

  return readFileSync(fullPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line, index) => {
      try {
        return [JSON.parse(line) as TraceEntry];
      } catch (error) {
        errors.push(
          `trace: line ${index + 1} is invalid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      }
    });
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
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

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: "data/inbox.json",
    output: "output.json",
    trace: ".trace/tool-calls.jsonl",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (flag === "--input") {
      args.input = value;
      i += 1;
    } else if (flag === "--output") {
      args.output = value;
      i += 1;
    } else if (flag === "--trace") {
      args.trace = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

function fail(errors: string[]): never {
  console.error("Validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

main();
