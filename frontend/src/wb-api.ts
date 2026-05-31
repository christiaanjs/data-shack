export const WORKER_BASE = import.meta.env.VITE_WORKER_URL ?? "";
const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN as string | undefined;

export async function authHeaders(): Promise<Record<string, string>> {
  if (DEV_TOKEN) return { "X-Dev-Token": DEV_TOKEN };
  const { getValidToken } = await import("./auth.ts");
  const token = await getValidToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
