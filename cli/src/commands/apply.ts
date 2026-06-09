import { createInterface } from "node:readline";
import pc from "picocolors";
import { ApiClient } from "../lib/api.js";
import { requireAuth } from "../lib/auth.js";
import { discoverResources } from "../lib/discovery.js";
import { computePlan, sortByKindOrder, sortByKindOrderReverse } from "../lib/planner.js";
import {
  createResource,
  deleteResource,
  fetchNameIndex,
  updateResource,
} from "../lib/resource-ops.js";
import type { NameIndex } from "../lib/resource-ops.js";
import { loadState, saveState } from "../lib/state.js";

export async function applyCommand(opts: { yes?: boolean }): Promise<void> {
  const auth = requireAuth();
  const api = new ApiClient(auth);
  const state = loadState();
  const files = discoverResources();
  const changes = computePlan(files, state);

  const errors = changes.filter((c) => c.error);
  if (errors.length > 0) {
    for (const e of errors) console.error(pc.red(`! ${e.path}: ${e.error}`));
    process.exit(1);
  }

  const creates = sortByKindOrder(changes.filter((c) => c.kind === "create"));
  const updates = sortByKindOrder(changes.filter((c) => c.kind === "update"));
  const deletes = sortByKindOrderReverse(changes.filter((c) => c.kind === "delete"));

  if (creates.length === 0 && updates.length === 0 && deletes.length === 0) {
    console.log(pc.green("✓ No changes."));
    return;
  }

  for (const c of creates) console.log(`  ${pc.green("+")} ${c.path}`);
  for (const c of updates) console.log(`  ${pc.yellow("~")} ${c.path}`);
  for (const c of deletes) console.log(`  ${pc.red("-")} ${c.path}`);
  console.log(
    `\nPlan: ${creates.length} to add, ${updates.length} to change, ${deletes.length} to destroy.`,
  );

  if (!opts.yes) {
    const answer = await prompt("Apply? [y/N] ");
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  // Resolve credential/backend name → id maps, updated as we create new resources
  const idx: NameIndex = await fetchNameIndex(api);

  let failed = false;

  for (const c of [...creates, ...updates]) {
    const res = c.resolved!;
    const verb = c.kind === "create" ? "Creating" : "Updating";
    process.stdout.write(`  ${verb} ${c.path}... `);
    try {
      const entry =
        c.kind === "create"
          ? await createResource(api, res, idx)
          : await updateResource(api, res, c.existing!, idx);
      entry.hash = c.hash!;
      state.resources[c.path] = entry;
      // Keep name index fresh for later resources in the same run
      if (res.kind === "credential") idx.credByName.set(res.name, entry.id);
      if (res.kind === "storage-backend") idx.backendByName.set(res.name, entry.id);
      saveState(state);
      console.log(pc.green("done") + pc.dim(` (${entry.id})`));
    } catch (e) {
      console.log(pc.red("failed"));
      console.error(pc.red(`    ${(e as Error).message}`));
      failed = true;
    }
  }

  for (const c of deletes) {
    process.stdout.write(`  Deleting ${c.path}... `);
    try {
      await deleteResource(api, c.existing!);
      delete state.resources[c.path];
      saveState(state);
      console.log(pc.green("done"));
    } catch (e) {
      console.log(pc.red("failed"));
      console.error(pc.red(`    ${(e as Error).message}`));
      failed = true;
    }
  }

  if (failed) {
    console.error(pc.red("\nApply completed with errors."));
    process.exit(1);
  }
  console.log(pc.green("\n✓ Apply complete."));
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
