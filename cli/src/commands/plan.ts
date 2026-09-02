import pc from "picocolors";
import { discoverResources } from "../lib/discovery.js";
import { computePlan } from "../lib/planner.js";
import { loadState } from "../lib/state.js";

export function planCommand(): void {
  const state = loadState();
  const files = discoverResources();
  const changes = computePlan(files, state);

  const creates = changes.filter((c) => c.kind === "create");
  const updates = changes.filter((c) => c.kind === "update");
  const deletes = changes.filter((c) => c.kind === "delete");
  const unchanged = changes.filter((c) => c.kind === "no-change");
  const errors = changes.filter((c) => c.error);

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(pc.red(`! ${e.path}: ${e.error}`));
    }
    process.exit(1);
  }

  if (creates.length === 0 && updates.length === 0 && deletes.length === 0) {
    console.log(pc.green("✓ No changes — infrastructure is up to date."));
    if (unchanged.length > 0) console.log(pc.dim(`  ${unchanged.length} resource(s) unchanged.`));
    return;
  }

  for (const c of creates) {
    const kind = c.resource?.kind ?? "?";
    console.log(`  ${pc.green("+")} ${c.path} ${pc.dim(`[${kind}]`)}`);
  }
  for (const c of updates) {
    const kind = c.resource?.kind ?? "?";
    console.log(`  ${pc.yellow("~")} ${c.path} ${pc.dim(`[${kind}]`)}`);
  }
  for (const c of deletes) {
    const kind = c.existing?.kind ?? "?";
    console.log(`  ${pc.red("-")} ${c.path} ${pc.dim(`[${kind}]`)}`);
  }

  console.log(
    `\nPlan: ${pc.green(`${creates.length} to add`)}, ${pc.yellow(`${updates.length} to change`)}, ${pc.red(`${deletes.length} to destroy`)}.`,
  );
  if (unchanged.length > 0) console.log(pc.dim(`(${unchanged.length} unchanged)`));
}
