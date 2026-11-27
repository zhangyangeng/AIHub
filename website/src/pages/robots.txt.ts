import type { APIRoute } from 'astro';

// robots 不屏蔽任何爬虫，包括 GPTBot / ClaudeBot / PerplexityBot / Google-Extended。
// 这个站的内容本来就希望被引用（见 DESIGN.md 第 10 节）。
export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL('sitemap-index.xml', site).href;

  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${sitemap}`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
