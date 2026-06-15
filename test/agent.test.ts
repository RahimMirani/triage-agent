import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  applySafetyNet,
  classifyDeterministic,
  detectSafeguarding,
  extractIntake,
  fallbackTriage,
  normalizeItemOutput,
  runAgent,
} from "../src/agent.js";
import { configureTrace, withItemContext } from "../src/tools.js";
import type { InboxItem, ItemOutput } from "../src/types.js";

// Tests exercise the deterministic path only (no API key), which is exactly
// what the graceful fallback uses. They are offline, free, and CI-safe.

function freshTrace(): void {
  const dir = mkdtempSync(join(tmpdir(), "triage-trace-"));
  configureTrace({ path: join(dir, "trace.jsonl") });
}

const inbox: InboxItem[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "data/inbox.json"), "utf8"),
);
const byId = (id: string): InboxItem => {
  const item = inbox.find((i) => i.id === id);
  if (!item) throw new Error(`missing fixture ${id}`);
  return item;
};

before(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("safeguarding detection", () => {
  test("flags the Leo voicemail (item_2) as safeguarding", () => {
    assert.equal(detectSafeguarding(byId("item_2")), true);
    assert.equal(classifyDeterministic(byId("item_2")).classification, "safeguarding");
    assert.equal(classifyDeterministic(byId("item_2")).urgency, "P0");
  });

  test("does NOT flag the URGENT reschedule (item_8) as safeguarding", () => {
    assert.equal(detectSafeguarding(byId("item_8")), false);
  });

  test("does not over-trigger on a routine referral (item_1)", () => {
    assert.equal(detectSafeguarding(byId("item_1")), false);
  });
});

describe("urgency calibration / over-escalation clamp", () => {
  test("URGENT same-day reschedule (item_8) is P1 scheduling, not P0", () => {
    const c = classifyDeterministic(byId("item_8"));
    assert.equal(c.classification, "scheduling");
    assert.equal(c.urgency, "P1");
  });

  test("safety net clamps an unjustified P0 down", async () => {
    freshTrace();
    const item = byId("item_1");
    const out = await withItemContext(item.id, async () =>
      applySafetyNet(item, {
        classification: "new_referral",
        urgency: "P0",
        extracted_intake: extractIntake(item),
        missing_info: [],
        recommended_next_action: "x",
        draft_reply: null,
        escalation: { reason: "overzealous", severity: "P0" },
        decision_rationale: "x",
      }),
    );
    assert.notEqual(out.urgency, "P0");
    assert.equal(out.escalation, null);
  });

  test("safety net forces P0 + escalation for safeguarding input", async () => {
    freshTrace();
    const item = byId("item_2");
    const out = await withItemContext(item.id, async () =>
      applySafetyNet(item, {
        classification: "new_referral",
        urgency: "P2",
        extracted_intake: extractIntake(item),
        missing_info: [],
        recommended_next_action: "",
        draft_reply: null,
        escalation: null,
        decision_rationale: "",
      }),
    );
    assert.equal(out.classification, "safeguarding");
    assert.equal(out.urgency, "P0");
    assert.equal(out.escalation?.severity, "P0");
  });
});

describe("extraction", () => {
  test("extracts structured fields from a fax referral (item_1)", () => {
    const intake = extractIntake(byId("item_1"));
    assert.equal(intake.dob_or_age, "2018-09-04");
    assert.deepEqual(intake.discipline, ["SLP"]);
    assert.match(intake.member_id ?? "", /BCBS-884200/);
    assert.match(intake.parent_contact ?? "", /daniel\.lee@example\.com/);
  });

  test("recognizes blanks as missing in incomplete referral (item_6)", () => {
    const intake = extractIntake(byId("item_6"));
    assert.equal(intake.dob_or_age, null);
    assert.equal(intake.payer, null);
    assert.equal(intake.member_id, null);
  });
});

describe("normalizeItemOutput", () => {
  test("forces a valid shape from a garbage decision", () => {
    freshTrace();
    const item = byId("item_1");
    const out = normalizeItemOutput(item, {
      // deliberately invalid values
      classification: "not_a_class" as never,
      urgency: "P9" as never,
      extracted_intake: {
        child_name: "  ",
        dob_or_age: null,
        parent_contact: null,
        discipline: ["SLP", "XX", "SLP"] as never,
        diagnosis_or_concern: null,
        payer: null,
        member_id: null,
      },
      missing_info: ["a", 5 as never, "b"],
      recommended_next_action: "",
      draft_reply: "  ",
      escalation: { reason: "x", severity: "P5" as never },
      decision_rationale: "",
    });
    assert.equal(out.classification, "other");
    assert.equal(out.urgency, "P2");
    assert.equal(out.requires_human_review, true);
    assert.deepEqual(out.extracted_intake.discipline, ["SLP"]);
    assert.equal(out.extracted_intake.child_name, null);
    assert.deepEqual(out.missing_info, ["a", "b"]);
    assert.ok(out.recommended_next_action.length > 0);
    assert.ok(out.decision_rationale.length > 0);
    assert.equal(out.draft_reply, null);
    assert.equal(out.escalation, null);
  });

  test("drops fabricated tool calls (only trace-backed calls survive)", () => {
    freshTrace();
    const item = byId("item_1");
    const out = normalizeItemOutput(item, {
      classification: "new_referral",
      urgency: "P2",
      extracted_intake: extractIntake(item),
      missing_info: [],
      recommended_next_action: "x",
      draft_reply: null,
      escalation: null,
      decision_rationale: "x",
    });
    // No tools were called inside a context for this item, so none survive.
    assert.deepEqual(out.tools_called, []);
  });
});

describe("fallbackTriage produces valid output for every visible item", () => {
  for (const item of inbox) {
    test(`item ${item.id} is schema-shaped`, async () => {
      freshTrace();
      const out = await withItemContext(item.id, async () => {
        const decision = await fallbackTriage(item);
        const safe = await applySafetyNet(item, decision);
        return normalizeItemOutput(item, safe);
      });
      assertValidItemOutput(out, item.id);
      // Every surfaced tool call is trace-backed and uniquely owned.
      for (const call of out.tools_called) {
        assert.ok(call.call_id && call.name && call.result_summary);
      }
    });
  }

  test("Spanish referral (item_7) drafts in Spanish", async () => {
    freshTrace();
    const item = byId("item_7");
    const out = await withItemContext(item.id, async () => {
      const decision = await fallbackTriage(item);
      return normalizeItemOutput(item, await applySafetyNet(item, decision));
    });
    const draftCall = out.tools_called.find((c) => c.name === "draft_message");
    assert.equal(draftCall?.args.language, "es");
  });

  test("out-of-network referral (item_3) routes to billing, holds no slot", async () => {
    freshTrace();
    const item = byId("item_3");
    const out = await withItemContext(item.id, async () => {
      const decision = await fallbackTriage(item);
      return normalizeItemOutput(item, await applySafetyNet(item, decision));
    });
    assert.ok(out.tools_called.some((c) => c.name === "verify_insurance"));
    assert.ok(!out.tools_called.some((c) => c.name === "hold_slot"));
    assert.match(out.recommended_next_action.toLowerCase(), /billing|benefits|out-of-network/);
  });
});

describe("golden end-to-end (deterministic, no key)", () => {
  test("runAgent covers every item with valid, audit-consistent output", async () => {
    freshTrace();
    const outputs = await runAgent(inbox);

    assert.equal(outputs.length, inbox.length);
    const ids = new Set(outputs.map((o) => o.item_id));
    for (const item of inbox) assert.ok(ids.has(item.id), `missing ${item.id}`);

    for (const out of outputs) {
      assertValidItemOutput(out, out.item_id);
      assert.equal(out.requires_human_review, true);
    }

    // At least 3 distinct tools across the batch (validator threshold).
    const distinct = new Set<string>();
    for (const out of outputs) for (const c of out.tools_called) distinct.add(c.name);
    assert.ok(distinct.size >= 3, `only ${distinct.size} distinct tools`);

    // Safeguarding item must be P0 with an escalation.
    const leo = outputs.find((o) => o.item_id === "item_2");
    assert.equal(leo?.urgency, "P0");
    assert.equal(leo?.classification, "safeguarding");
    assert.equal(leo?.escalation?.severity, "P0");

    // Reschedule must be P1, never P0.
    const noah = outputs.find((o) => o.item_id === "item_8");
    assert.equal(noah?.urgency, "P1");
  });
});

function assertValidItemOutput(out: ItemOutput, id: string): void {
  const classifications = [
    "new_referral",
    "existing_patient_request",
    "scheduling",
    "clinical_question",
    "billing_question",
    "missing_paperwork",
    "provider_followup",
    "complaint",
    "safeguarding",
    "spam",
    "other",
  ];
  assert.equal(out.item_id, id);
  assert.ok(classifications.includes(out.classification), `bad classification ${out.classification}`);
  assert.ok(["P0", "P1", "P2", "P3"].includes(out.urgency));
  assert.equal(out.requires_human_review, true);
  assert.ok(out.recommended_next_action.length > 0);
  assert.ok(out.decision_rationale.length > 0);
  assert.ok(Array.isArray(out.missing_info));
  assert.ok(Array.isArray(out.task_ids));
  assert.ok(Array.isArray(out.tools_called));
  // intake has all 7 keys
  for (const key of [
    "child_name",
    "dob_or_age",
    "parent_contact",
    "discipline",
    "diagnosis_or_concern",
    "payer",
    "member_id",
  ]) {
    assert.ok(key in out.extracted_intake, `intake missing ${key}`);
  }
  if (out.extracted_intake.discipline !== null) {
    assert.ok(out.extracted_intake.discipline.length > 0);
    for (const d of out.extracted_intake.discipline) {
      assert.ok(["SLP", "OT", "PT"].includes(d));
    }
  }
  if (out.escalation !== null) {
    assert.ok(["P0", "P1"].includes(out.escalation.severity));
    assert.ok(out.escalation.reason.length > 0);
  }
}

after(() => {
  // nothing to clean; temp dirs are OS-managed
});
