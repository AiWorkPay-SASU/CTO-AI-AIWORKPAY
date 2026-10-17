// MissionControl: the token lives only in this closure (never persisted: no browser storage, no cookie, not in the URL).
// All dynamic content is inserted with textContent, never innerHTML.
(() => {
  let token = null;
  let role = null;
  let timer = null;
  const $ = (id) => document.getElementById(id);

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'onclick') node.addEventListener('click', v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  };
  const badge = (status) => el('span', { class: `badge ${status}` }, status);

  function banner(message, kind = 'error') {
    const b = $('banner');
    b.textContent = message;
    b.className = kind === 'info' ? 'info' : '';
    b.hidden = !message;
  }

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        ...options,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch {
      throw new Error('Hors ligne ou serveur injoignable.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      stop();
      throw new Error('Session expirée ou jeton invalide : reconnectez-vous.');
    }
    if (res.status === 403) throw new Error(data.error || 'Droits insuffisants (jeton en lecture seule ?).');
    if (res.status === 429) throw new Error('Trop de requêtes : patientez une minute.');
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    token = null;
    role = null;
    $('who').hidden = true;
  }

  async function guarded(fn) {
    try {
      banner('');
      await fn();
    } catch (e) {
      banner(e.message);
    }
  }

  function renderAgents(agents) {
    const ul = $('agents');
    ul.replaceChildren(...agents.map((a) => el('li', { class: 'row' },
      el('strong', {}, a.role), a.read_only ? el('span', { class: 'muted' }, 'lecture seule') : '',
      el('span', { class: 'muted' }, a.capabilities.join(', ')),
      badge(a.running_tasks.length ? 'running' : 'queued'),
      el('span', { class: 'muted' }, `${a.running_tasks.length} tâche(s) · plafond ${a.max_budget_usd} USD`))));
  }

  function approvalButtons(m) {
    const kind = { pending_approval: 'mission', awaiting_owner: 'architecture', review: 'completion' }[m.status];
    if (!kind || role !== 'owner') return '';
    const labels = { mission: 'Démarrer la mission', architecture: "Valider l'architecture", completion: 'Valider le résultat (sans fusion)' };
    const decide = (decision) => guarded(async () => {
      await api(`/api/missions/${m.id}/approvals`, { method: 'POST', body: { kind, decision } });
      await refresh();
    });
    return el('div', { class: 'row' },
      el('strong', {}, `Décision requise : ${kind}`),
      el('button', { onclick: () => decide('approve') }, labels[kind]),
      el('button', { class: 'danger', onclick: () => decide('reject') }, 'Refuser'));
  }

  async function loadDetails(m, box) {
    const events = await api(`/api/missions/${m.id}/events`);
    const report = await api(`/api/missions/${m.id}/report`);
    box.replaceChildren(
      el('h3', {}, 'Rapports'),
      ...m.reports.map((r) => el('div', {},
        el('div', { class: 'row' }, el('strong', {}, r.role), badge(r.verdict),
          el('span', { class: 'muted' }, `tests ${r.report.tests.passed} ok / ${r.report.tests.failed} ko · ${r.cost_usd.toFixed(4)} USD`)),
        r.problems.length ? el('pre', {}, r.problems.join('\n---\n')) : '')),
      el('h3', {}, 'Journal d’audit'),
      el('table', {}, ...events.map((e) => el('tr', {},
        el('td', { class: 'muted' }, e.at.slice(11, 19)), el('td', {}, e.type), el('td', { class: 'muted' }, e.actor),
        el('td', { class: 'muted' }, JSON.stringify(e.detail).slice(0, 160))))),
      el('h3', {}, 'Corps de PR proposé'),
      el('pre', {}, report.pull_request_body));
  }

  function renderMission(m) {
    const details = el('div', {});
    const box = el('details', {}, el('summary', {}, 'Rapports, audit, PR'), details);
    box.addEventListener('toggle', () => { if (box.open) guarded(() => loadDetails(m, details)); });
    return el('article', { class: 'mission' },
      el('div', { class: 'row' }, badge(m.status), el('strong', {}, m.project),
        el('span', { class: 'muted' }, `${m.spent_usd.toFixed(4)} / ${m.budget_usd} USD`)),
      el('p', {}, m.objective),
      m.blockers?.length ? el('div', { class: 'row' }, badge('blocked'), ...m.blockers.map((b) => el('span', {}, b))) : '',
      el('table', {}, el('tr', {}, ...['agent', 'état', 'tentatives', 'corrections', 'échecs'].map((h) => el('th', {}, h))),
        ...m.tasks.map((t) => el('tr', {}, el('td', {}, t.role), el('td', {}, badge(t.status)),
          el('td', {}, t.attempts), el('td', {}, t.corrections), el('td', {}, t.failures)))),
      approvalButtons(m),
      !['completed', 'cancelled', 'failed'].includes(m.status) && role === 'owner'
        ? el('button', { class: 'danger', onclick: () => guarded(async () => { await api(`/api/missions/${m.id}/cancel`, { method: 'POST', body: {} }); await refresh(); }) }, 'Annuler')
        : '',
      box);
  }

  async function refresh() {
    if (!token) return;
    const [agents, missions] = await Promise.all([api('/api/agents'), api('/api/missions')]);
    renderAgents(agents);
    $('empty').hidden = missions.length > 0;
    const open = new Set([...document.querySelectorAll('.mission details[open]')].map((d) => d.closest('.mission')?.dataset.id));
    $('missions').replaceChildren(...missions.map((m) => {
      const node = renderMission(m);
      node.dataset.id = m.id;
      if (open.has(m.id)) node.querySelector('details').open = true;
      return node;
    }));
  }

  $('login').addEventListener('submit', (ev) => {
    ev.preventDefault();
    token = $('token').value;
    $('token').value = '';
    guarded(async () => {
      role = (await api('/api/whoami')).role;
      $('who').hidden = false;
      $('who').textContent = `Connecté : ${role}`;
      await refresh();
      timer = setInterval(() => { if (!document.hidden) guarded(refresh); }, 3000);
    });
  });

  $('new-mission').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(async () => {
      await api('/api/missions', {
        method: 'POST',
        body: { project: $('project').value, objective: $('objective').value, budget_usd: Number($('budget').value) }
      });
      $('objective').value = '';
      await refresh();
    });
  });
})();
