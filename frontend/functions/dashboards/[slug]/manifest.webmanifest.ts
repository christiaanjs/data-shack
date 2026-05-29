interface PagesContext {
  params: Record<string, string>;
  request: Request;
}

function slugToTitle(slug: string): string {
  if (/^[0-9a-f-]+$/.test(slug)) return "Dashboard";
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { slug } = context.params;
  const title = slugToTitle(slug);

  const manifest = {
    name: title,
    short_name: title,
    start_url: `/dashboards/${slug}`,
    // scope "/" keeps this within the main installed PWA so auth (tokens,
    // cookies) is shared across the main app and all dashboard shortcuts.
    scope: "/",
    display: "standalone",
    background_color: "#1d2433",
    theme_color: "#1d4ed8",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache",
    },
  });
}
