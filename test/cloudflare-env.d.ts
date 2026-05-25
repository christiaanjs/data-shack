// Augment Cloudflare.Env with project-specific bindings so tests that pass
// `env` directly to worker functions typecheck correctly.
declare namespace Cloudflare {
  interface Env {
    SESSION_DO: DurableObjectNamespace;
  }
}
