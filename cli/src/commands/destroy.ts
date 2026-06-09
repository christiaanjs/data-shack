import { createInterface } from "node:readline";
import pc from "picocolors";
import { ApiClient } from "../lib/api.js";
import { requireAuth } from "../lib/auth.js";
import { deleteResource } from "../lib/resource-ops.js";
import { loadState, saveState } from "../lib/state.js";

export async function destroyCommand(pathArg: string, opts: { yes?: boolean }): Promise<void> {
  const auth = requireAuth();
  const api = new ApiClient(auth);
  const state = loadState();

  // Support glob-style "all" or a specific path
  let targets: string[];
  if (pathArg === "--all") {
    targets = Object.keys(state.resources);
  } else {
    // Normalize: strip leading ./ if present
    const normalized = pathArg.replace(/^\.\//, "");
    if (!state.resources[normalized]) {
      console.error(pc.red(`No tracked resource at: ${normalized}`));
      console.log(pc.dim("Tracked paths:"));
      for (const p of Object.keys(state.resources)) console.log(pc.dim(`  ${p}`));
      process.exit(1);
    }
    targets = [normalized];
  }

  for (const t of targets) {
    const entry = state.resources[t]!;
    console.log(`  ${pc.red("-")} ${t} ${pc.dim(`[${entry.kind} / ${entry.id}]`)}`);
  }

  if (!opts.yes) {
    const answer = await prompt(
      targets.length === 1
        ? `Destroy ${targets[0]}? [y/N] `
        : `Destroy ${targets.length} resources? [y/N] `,
    );
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  let failed = false;
  for (const t of targets) {
    const entry = state.resources[t]!;
    process.stdout.write(`  Deleting ${t}... `);
    try {
      await deleteResource(api, entry);
      delete state.resources[t];
      saveState(state);
      console.log(pc.green("done"));
    } catch (e) {
      console.log(pc.red("failed"));
      console.error(pc.red(`    ${(e as Error).message}`));
      failed = true;
    }
  }

  if (failed) process.exit(1);
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
