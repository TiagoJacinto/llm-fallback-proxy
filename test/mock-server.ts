import { serve } from 'bun';

let remaining = 99.5;

serve({
  port: 8318,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/usage/agy') {
      console.log('Serving usage for agy: ', remaining);
      // 30 days in seconds, and reset timestamp 15 days from now
      const duration = 30 * 24 * 60 * 60;
      const reset = new Date(Date.now() + 86400000 * 15).toISOString();
      return Response.json({ remaining, duration, reset });
    }
    if (url.pathname === '/api/usage/agy/set') {
       remaining = parseFloat(url.searchParams.get('r') || '0');
       return Response.json({ remaining });
    }
    return new Response('Not Found', { status: 404 });
  }
});
console.log('Mock usage server listening on 8318');
