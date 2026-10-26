import os from 'node:os';
import { run } from './workspace.js';
import { redact, sanitizeText } from './util.js';

/**
 * GitHub access of the CTO. It is deliberately narrow: the only things it can do are
 *   - push a CTO task branch (never any other ref, never forced),
 *   - open a DRAFT pull request,
 *   - read the check runs and statuses of a commit.
 * Merging, closing, deleting, deploying and every other endpoint are refused before any request is made,
 * so even a stolen or over-privileged token cannot be used through this code to merge or deploy.
 * The token lives only in this object and in the environment of the push process: agents never see it.
 */
const SLUG = '[A-Za-z0-9_.-]+';
const ALLOWED_REQUESTS = [
  ['GET', new RegExp(`^/repos/${SLUG}/${SLUG}$`)],
  ['POST', new RegExp(`^/repos/${SLUG}/${SLUG}/pulls$`)],
  ['GET', new RegExp(`^/repos/${SLUG}/${SLUG}/commits/[0-9a-f]{7,40}/(check-runs|status)$`)]
];
export const CTO_BRANCH_RE = /^cto\/[0-9a-f]{8}\/[a-z]+-[0-9a-f]{8}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const GOOD_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export class GitHubClient {
  constructor({
    token, apiBase = 'https://api.github.com', gitBase = 'https://github.com', allowedRepos = [],
    fetchImpl = globalThis.fetch, timeoutMs = 15000
  }) {
    if (!token || token.length < 20) throw new Error('A GitHub token is required');
    if (!allowedRepos.length) throw new Error('At least one authorized repository is required');
    for (const repo of allowedRepos) if (!PROJECT_RE.test(repo)) throw new Error(`Invalid authorized repository ${repo}`);
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.gitBase = gitBase.replace(/\/+$/, '');
    this.allowedRepos = new Set(allowedRepos.map((r) => r.toLowerCase()));
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  isAllowed(project) {
    return PROJECT_RE.test(String(project)) && this.allowedRepos.has(String(project).toLowerCase());
  }

  #assertAllowed(project) {
    if (!this.isAllowed(project)) throw new Error(`Repository ${sanitizeText(project, 80)} is not authorized for GitHub operations`);
  }

  remoteUrl(project) {
    this.#assertAllowed(project);
    return `${this.gitBase}/${project}.git`;
  }

  async #request(method, path, body) {
    if (!ALLOWED_REQUESTS.some(([m, re]) => m === method && re.test(path.split('?')[0]))) {
      throw new Error(`GitHub request ${method} ${path.split('?')[0]} is not permitted for the CTO`);
    }
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cto-ai-missioncontrol',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} failed: ${res.status} ${redact(text).slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async defaultBranch(project) {
    this.#assertAllowed(project);
    const repo = await this.#request('GET', `/repos/${project}`);
    return repo.default_branch;
  }

  /** Always a draft: a human decides when (and whether) it leaves draft state and merges. */
  async openDraftPullRequest({ project, head, base, title, body }) {
    this.#assertAllowed(project);
    if (!CTO_BRANCH_RE.test(head)) throw new Error('Only CTO task branches can be proposed');
    const pr = await this.#request('POST', `/repos/${project}/pulls`, {
      title: sanitizeText(title, 200), head, base, body: redact(sanitizeText(body, 60000)), draft: true, maintainer_can_modify: false
    });
    return { number: pr.number, url: pr.html_url, draft: Boolean(pr.draft) };
  }

  /** Combines check runs and commit statuses. Absence of any check is `none`, never `success`. */
  async commitChecks(project, sha) {
    this.#assertAllowed(project);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('Invalid commit sha');
    const checks = [];
    for (let page = 1; page <= 5; page += 1) {
      const data = await this.#request('GET', `/repos/${project}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      for (const run of data.check_runs ?? []) {
        const done = run.status === 'completed';
        checks.push({
          name: sanitizeText(run.name, 120),
          state: !done ? 'pending' : GOOD_CONCLUSIONS.has(run.conclusion) ? 'success' : 'failure',
          detail: redact(sanitizeText(`${run.conclusion ?? run.status}: ${run.output?.title ?? ''} ${run.output?.summary ?? ''}`, 600))
        });
      }
      if ((data.check_runs ?? []).length < 100) break;
    }
    const combined = await this.#request('GET', `/repos/${project}/commits/${sha}/status`);
    for (const s of combined.statuses ?? []) {
      checks.push({
        name: sanitizeText(s.context, 120),
        state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
        detail: redact(sanitizeText(`${s.state}: ${s.description ?? ''}`, 600))
      });
    }
    const state = checks.some((c) => c.state === 'failure') ? 'failure'
      : checks.some((c) => c.state === 'pending') ? 'pending'
        : checks.length ? 'success' : 'none';
    return { state, checks };
  }

  /**
   * Pushes one commit to one CTO branch, fast-forward only. The credential goes to the git process through its
   * environment (not its arguments) and only for an https remote.
   */
  async pushBranch({ repoPath, project, branch, commit }) {
    this.#assertAllowed(project);
    if (!CTO_BRANCH_RE.test(branch)) throw new Error('Refusing to push a branch that is not a CTO task branch');
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('A full commit sha is required');
    const remote = this.remoteUrl(project);
    const env = {
      PATH: process.env.PATH, HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0'
    };
    if (remote.startsWith('https://')) {
      const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
      Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
    }
    const res = await run('git', ['-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', remote, `${commit}:refs/heads/${branch}`],
      { cwd: repoPath, env, timeoutMs: 120000 });
    if (res.code !== 0) throw new Error(`git push failed: ${redact(res.stderr || res.stdout).slice(0, 300)}`);
    return { remote: remote.replace(/^(https?:\/\/)[^/@]*@/, '$1'), branch, commit };
  }
}

export function githubFromEnv(env = process.env) {
  if (!env.CTO_GITHUB_TOKEN) return null;
  const allowedRepos = (env.CTO_ALLOWED_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  return new GitHubClient({ token: env.CTO_GITHUB_TOKEN, allowedRepos });
}
