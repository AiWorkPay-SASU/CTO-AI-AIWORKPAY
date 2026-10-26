import http from 'node:http';

/**
 * SIMULATED PostgREST server used only to test SupabaseStore's HTTP contract
 * (headers, filters, optimistic locking). It is NOT Supabase: a green run here says nothing
 * about RLS, real migrations or network behaviour of a live project.
 */
export async function startFakePostgrest({ apiKey = 'test-service-key-0123456789', maxRows = 1000 } = {}) {
  const tables = new Map();
  const requests = [];
  let inserted = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const table = url.pathname.replace('/rest/v1/', '');
    requests.push({ method: req.method, table, query: url.search, headers: req.headers });
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers.apikey !== apiKey || req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { message: 'bad key' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rows = tables.get(table) ?? tables.set(table, []).get(table);
    const filters = [...url.searchParams.entries()].filter(([, v]) => v.startsWith('eq.'));
    const matches = (row) => filters.every(([k, v]) => String(row[k]) === decodeURIComponent(v.slice(3)));

    if (req.method === 'GET') {
      // Mirrors the documented PostgREST/Supabase behaviour: a response never holds more than `maxRows`
      // rows (default 1000) unless the client pages with limit/offset. Order is created_at, id when asked.
      const ordered = url.searchParams.get('order')
        ? [...rows.filter(matches)].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
        : rows.filter(matches);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? Infinity), maxRows);
      return reply(200, ordered.slice(offset, offset + limit));
    }
    if (req.method === 'POST') {
      const body = JSON.parse(raw);
      if (rows.some((r) => r.id === body.id)) return reply(409, { message: 'duplicate key' });
      // Postgres timestamps have microsecond precision; emulate it so insertion order stays distinguishable.
      inserted += 1;
      const now = `${new Date().toISOString().slice(0, -1)}${String(inserted % 1000).padStart(3, '0')}Z`;
      const row = { rev: 0, created_at: now, updated_at: now, ...body };
      rows.push(row);
      return reply(201, [row]);
    }
    if (req.method === 'PATCH') {
      const hit = rows.filter(matches);
      for (const row of hit) Object.assign(row, JSON.parse(raw));
      return reply(200, hit);
    }
    return reply(405, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    apiKey,
    requests,
    tables,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
