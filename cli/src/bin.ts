#!/usr/bin/env node
import { Command } from "commander";
import { applyCommand } from "./commands/apply.js";
import { authLogin, authLogout, authSetToken, authStatus } from "./commands/auth.js";
import { destroyCommand } from "./commands/destroy.js";
import { initCommand } from "./commands/init.js";
import { planCommand } from "./commands/plan.js";

const program = new Command();

program
  .name("dshack")
  .description("IaC CLI for data-shack warehouse configuration")
  .version("0.1.0");

// ── auth ────────────────────────────────────────────────────────────────────

const auth = program.command("auth").description("Manage authentication");

auth
  .command("login <worker-url>")
  .description("Authenticate via browser OAuth (PKCE)")
  .action((workerUrl: string) => authLogin(workerUrl));

auth
  .command("token <worker-url> <token>")
  .description("Store an existing JWT (for CI/dev environments)")
  .action((workerUrl: string, token: string) => authSetToken(workerUrl, token));

auth
  .command("logout")
  .description("Remove stored credentials")
  .action(() => authLogout());

auth
  .command("status")
  .description("Show current authentication status")
  .action(() => authStatus());

// ── init ────────────────────────────────────────────────────────────────────

program
  .command("init <worker-url>")
  .description("Initialise a workspace and optionally pull existing state")
  .option("--pull", "Pull all existing resources into YAML files")
  .action((workerUrl: string, opts: { pull?: boolean }) => initCommand(workerUrl, opts));

// ── plan ────────────────────────────────────────────────────────────────────

program
  .command("plan")
  .description("Show the changes required to reach desired state")
  .action(() => planCommand());

// ── apply ───────────────────────────────────────────────────────────────────

program
  .command("apply")
  .description("Apply changes to the live API")
  .option("-y, --yes", "Skip confirmation prompt")
  .action((opts: { yes?: boolean }) => applyCommand(opts));

// ── destroy ─────────────────────────────────────────────────────────────────

program
  .command("destroy <path>")
  .description("Delete a tracked resource by its YAML path")
  .option("-y, --yes", "Skip confirmation prompt")
  .action((path: string, opts: { yes?: boolean }) => destroyCommand(path, opts));

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
