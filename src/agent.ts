import type { InboxItem, ItemOutput } from "./types.js";

export async function runAgent(_inbox: InboxItem[]): Promise<ItemOutput[]> {
  throw new Error(
    "TODO: implement the triage agent in src/agent.ts. See README.md for the assignment brief.",
  );
}
