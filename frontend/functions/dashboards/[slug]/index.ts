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

export async function onRequest(context: PagesContext): Promise<Response> {
  const { slug } = context.params;

  const url = new URL(context.request.url);
  url.pathname = "/index.html";
  const asset: Response = await context.env.ASSETS.fetch(new Request(url, context.request));
  if (!asset.ok) return asset;

  const title = slugToTitle(slug);
  const html = (await asset.text())
    .replace('href="/manifest.webmanifest"', `href="/dashboards/${slug}/manifest.webmanifest"`)
    .replace("<title>Data Shack</title>", `<title>${title} — Data Shack</title>`);

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
