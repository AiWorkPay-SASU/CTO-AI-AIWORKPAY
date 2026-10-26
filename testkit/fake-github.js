import http from 'node:http';

/**
 * SIMULATED GitHub REST API, used only to test what the CTO sends and how it reacts to check results.
 * It is NOT GitHub: a green run here says nothing about real tokens, branch protection, rate limits or real CI.
 * It records every request so tests can prove that nothing outside the narrow allowed set was ever attempted
 * (in particular: no merge).
 */
export async function startFakeGitHub({ token, defaultBranch = 'main' }) {
  const requests = [];
  const pulls = [];
  const checks = new Map(); // sha -> [{ name, status, conclusion, output }]
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null, headers: req.headers });
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/))) return reply(200, { default_branch: defaultBranch });
    if (req.method === 'POST' && url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls$/)) {
      const body = JSON.parse(raw);
      const pr = { number: pulls.length + 1, html_url: `https://github.example${url.pathname}/${pulls.length + 1}`, draft: body.draft === true, ...body };
      pulls.push(pr);
      return reply(201, pr);
    }
    if (req.method === 'GET' && (m = url.pathname.match(/\/commits\/([0-9a-f]+)\/check-runs$/))) {
      return reply(200, { total_count: (checks.get(m[1]) ?? []).length, check_runs: checks.get(m[1]) ?? [] });
    }
    if (req.method === 'GET' && url.pathname.match(/\/commits\/[0-9a-f]+\/status$/)) return reply(200, { state: 'pending', statuses: [] });
    return reply(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    pulls,
    setChecks: (sha, list) => checks.set(sha, list),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export const checkRun = (name, conclusion, summary = '') => ({
  name, status: conclusion ? 'completed' : 'in_progress', conclusion: conclusion ?? null, output: { title: name, summary }
});
