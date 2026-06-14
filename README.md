# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

Origin builds software for pediatric therapy practices. In this assignment, you are helping a fictional practice, Cedar Kids Therapy, triage its Monday inbox.

## Scenario

It is Monday at 8am at a multi-disciplinary pediatric therapy practice supporting speech-language pathology, occupational therapy, and physical therapy. The shared inbox accumulated items over the weekend from pediatrician fax referrals, parent voicemails, parent portal messages, and emails. Build an AI agent prototype that turns the messy batch into a sorted, human-reviewable action plan.

## What We Expect

Strong submissions are usually incomplete but honest. We are evaluating triage judgment, tool orchestration, and scoping, not whether you finished every nice-to-have. Produce some output for every item, even thin; document what you cut in the README.

You may use any AI coding agent (Claude Code, Cursor, Codex, etc.) while building. State your stack and assumptions in your README.

Runtime LLM usage is allowed and recommended, but not required. Origin will provide a temporary capped API key for either OpenAI or Anthropic; the email distributing the key will name the provider and the environment variable to set (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). You may also use your own provider. You may install dependencies for the provider you choose (e.g., `npm install openai` or `npm install @anthropic-ai/sdk`). Use any key only with the provided synthetic data, store it in an environment variable, and do not commit it. Model choice is not part of the rubric.

## How To Run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

The commands also work with no flags and default to the paths above. Reviewers may run the same commands against similar hidden synthetic input. Do not hardcode input, output, or trace paths.

## Share And Submit

Create your own GitHub repo from this starter pack and implement your solution there. The repo can be public or private. When you are done, submit the repo link. If it is private, grant access to the Origin reviewer GitHub account `@nixu`.

Commit your code, your updated `README.md`, and your final generated `output.json`. Do not commit API keys, `.env` files, real PHI, `node_modules/`, or `.trace/`.

We expect you to spend about 2 hours. If you stop before finishing, commit what you have and describe the cuts in your README.

Update this README with these sections before submitting:

1. How to run
2. Stack and runtime
3. Architecture
4. Failure modes and production eval
5. What I chose not to build, and why
6. What I would do with another 4 hours

## Your Task

Implement the agent in `src/agent.ts`. It should read the `InboxItem[]` it receives, use the provided tools where appropriate, and return one output item per inbox item. `src/index.ts` wraps your items with `buildBatchOutput()` and writes the final `output.json`.

Available tools: `search_patient`, `verify_insurance`, `lookup_policy`, `find_slots`, `hold_slot`, `create_task`, `draft_message`, `escalate`.

Use `schema/output.schema.json` as the source of truth for the output shape. `data/example_output.json` shows one non-trivial worked item. It is illustrative and is not expected to pass validation by itself. **Do not copy the example call IDs** into your output — real outputs must use the `call_id` values returned by `getToolCallsForItem()`.

## Time Box

Spend about 2 hours. Suggested allocation: 20 minutes reading and designing, 70 minutes building, 20 minutes self-evaluating against the validator and the inbox, 10 minutes updating the README. Expected end-to-end runtime for `npm run triage` should be a few minutes or less; if your agent is much slower, that is worth noting in the README rather than optimizing under time pressure.

Minimum viable submission: processes every item in `data/inbox.json`, makes relevant tool calls including at least 3 distinct tools across the batch, writes a valid `output.json`, and passes `npm run validate`. Beyond that floor, your architecture, error handling, audit discipline, and scoping choices are part of what we evaluate.

## Constraints

- Use TypeScript, Node LTS, and npm. If this creates a real accessibility or environment issue, reach out.
- Use the provided tools in `src/tools.ts`; do not modify, reimplement, or bypass them. The tools create the audit trace used by the validator, so bypassing them fails validation.
- Use at least 3 distinct tools across the batch. Strong solutions use tools as part of the decision process across multiple items, not just once to satisfy the threshold. Irrelevant or performative tool calls will be penalized.
- Use `withItemContext(item.id, async () => ...)` around item-level tool calls.
- Use `getToolCallsForItem(item.id)` for `tools_called[]`; pass the returned entries through unchanged.
- Use `buildBatchOutput(items)` through the starter `src/index.ts`; do not hand-compute summary counts.
- Do not auto-send messages. Use `draft_message` only.
- Do not schedule appointments. `find_slots` and `hold_slot` are reviewable; scheduling is not.
- Use only synthetic data. Do not add real PHI.

## Urgency Calibration

- `P0`: safeguarding, imminent harm, mandated-reporter escalation. Same-hour human review.
- `P1`: same-day operational issue requiring prompt staff action.
- `P2`: normal intake, scheduling, billing, or clinical-review workflow.
- `P3`: low-priority admin, FYI, spam.

Default to `P2` unless there is a clear safety or same-day operational reason. Over-escalation is itself a production failure mode.

## Review Variants

Similar synthetic variants may be run during review. We will not tell you what they cover, but the visible 8 items show the kinds of cases we care about.

## Rubric

- Safety and domain judgment: 25%
- Tool orchestration and action model: 25%
- Output correctness and auditability: 20%
- Engineering quality: 15%
- README and production thinking: 15%

Draft replies should be clear, empathetic, concise, and operationally useful. They must not provide clinical advice or imply messages were sent.
