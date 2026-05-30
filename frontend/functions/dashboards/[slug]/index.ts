interface PagesContext {
  params: Record<string, string>;
  request: Request;
  env: { ASSETS: { fetch(r: RequestInfo): Promise<Response> } };
}

function slugToTitle(slug: string): string {
  // UUIDs (all hex + hyphens) get a generic fallback; real slugs get title-cased.
  if (/^[0-9a-f-]+$/.test(slug)) return "Dashboard";
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { slug } = context.params;

  // Fetch "/" not "/index.html" — Pages redirects /index.html → / internally,
  // which would cause our function to return the redirect and lose the URL.
  const rootUrl = new URL("/", context.request.url);
  const asset: Response = await context.env.ASSETS.fetch(rootUrl.toString());
  if (!asset.ok) return asset;

  const title = slugToTitle(slug);
  const safeSlug = encodeURIComponent(slug);
  const html = (await asset.text())
    .replace('href="/manifest.webmanifest"', `href="/dashboards/${safeSlug}/manifest.webmanifest"`)
    .replace("<title>Data Shack</title>", `<title>${escapeHtml(title)} — Data Shack</title>`);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      // Never cache: each slug gets a different manifest href, and index.html
      // itself may be updated between deploys.
      "Cache-Control": "no-store",
    },
  });
}
