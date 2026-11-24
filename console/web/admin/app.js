/* DeskHop Console - vanilla JS single page app */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const APP = window.APP_NAME && window.APP_NAME !== '__APP_NAME__' ? window.APP_NAME : 'DeskHop';
  const COLORS = ['#0e8ee9', '#7c5cff', '#18b26b', '#f2a516', '#e5484d', '#ec4899', '#14b8a6', '#64748b'];

  const S = { token: null, me: null, devices: [], groups: [], timer: null, filterGroup: 'all', filterState: 'all', q: '' };
  try { S.token = localStorage.getItem('nx_token'); } catch (e) { /* ignore */ }

  // ---------------- utils ----------------
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtId(id) { id = String(id || ''); return /^\d{7,12}$/.test(id) ? id.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : id; }
  function ago(ts) {
    if (!ts) return 'nooit';
    const s = Math.floor(Date.now() / 1000) - ts;
    if (s < 45) return 'zojuist';
    if (s < 3600) return Math.floor(s / 60) + ' min geleden';
    if (s < 86400) return Math.floor(s / 3600) + ' uur geleden';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' dagen geleden';
    return new Date(ts * 1000).toLocaleDateString('nl-NL');
  }
  function dt(ts) { return ts ? new Date(ts * 1000).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
  function dur(a, b) {
    if (!a) return '—';
    let s = (b || Math.floor(Date.now() / 1000)) - a;
    const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
    return (h ? h + 'u ' : '') + (h || m ? m + 'm ' : '') + s + 's';
  }
  function osIcon(os) {
    os = (os || '').toLowerCase();
    if (os.includes('windows')) return 'windows';
    if (os.includes('mac') || os.includes('darwin')) return 'apple';
    if (os.includes('android')) return 'android';
    if (os.includes('linux') || os.includes('ubuntu') || os.includes('debian')) return 'linux';
    return 'monitor';
  }
  function osShort(os) { return (os || '').split(' / ')[0] || '—'; }
  function initials(n) { return (n || '?').split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join(''); }

  async function api(method, path, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (S.token) opt.headers.Authorization = 'Bearer ' + S.token;
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch('/console-api' + path, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (r.status === 401 && path !== '/login') { logoutLocal(); throw new Error('Sessie verlopen'); }
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.innerHTML = icon(err ? 'info' : 'check', 18) + '<span>' + esc(msg) + '</span>';
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => t.remove(), 3600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Gekopieerd naar klembord'); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Gekopieerd naar klembord'); } catch (e2) { toast('Kopiëren mislukt', true); }
      ta.remove();
    }
  }
  function codebox(text, multiline) {
    return '<div class="codebox"><code>' + esc(text || '—') + '</code><button title="Kopieer" data-copy="' + esc(text) + '">' + icon('copy', 16) + '</button></div>';
  }

  function modal(title, bodyHtml, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const root = $('#modal-root');
      root.innerHTML = '<div class="modal-bg"><form class="modal" autocomplete="off"><div class="modal-h"><h3>' + esc(title) +
        '</h3><button type="button" class="icon-btn" data-x>' + icon('x') + '</button></div><div class="modal-b">' + bodyHtml +
        '</div><div class="err-msg" style="padding:0 22px"></div><div class="modal-f"><button type="button" class="btn" data-x>Annuleren</button><button class="btn ' +
        (opts.danger ? 'danger solid' : 'primary') + '">' + esc(opts.ok || 'Opslaan') + '</button></div></form></div>';
      const form = $('form', root);
      const close = v => { root.innerHTML = ''; resolve(v); };
      $$('[data-x]', root).forEach(b => b.onclick = () => close(null));
      $('.modal-bg', root).addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) close(null); });
      $$('.swatches button', root).forEach(b => b.onclick = () => {
        $$('.swatches button', root).forEach(x => x.classList.remove('on')); b.classList.add('on');
        $('[name=color]', root).value = b.dataset.c;
      });
      form.onsubmit = async e => {
        e.preventDefault();
        const vals = {};
        $$('input,select,textarea', form).forEach(i => { if (i.name) vals[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
        if (opts.onSubmit) {
          try { await opts.onSubmit(vals); close(vals); } catch (err) { $('.err-msg', root).textContent = err.message; }
        } else close(vals);
      };
      const first = $('input:not([type=hidden]),select', form); if (first) first.focus();
    });
  }
  function confirmBox(title, text, ok) {
    return modal(title, '<p style="margin:0 0 8px">' + esc(text) + '</p>', { ok: ok || 'Verwijderen', danger: true });
  }
  function swatches(cur) {
    return '<input type="hidden" name="color" value="' + esc(cur) + '"><div class="swatches">' +
      COLORS.map(c => '<button type="button" data-c="' + c + '" class="' + (c === cur ? 'on' : '') + '" style="background:' + c + '"></button>').join('') + '</div>';
  }

  function connect(id, pw) {
    id = String(id || '').replace(/\s+/g, '');
    if (!id) { toast('Vul een partner-ID in', true); return; }
    let url = 'rustdesk://connection/new/' + encodeURIComponent(id);
    if (pw) url += '?password=' + encodeURIComponent(pw);
    // If the app is installed the browser hands the link over and this window loses focus.
    // If nothing happens within a few seconds, the app is most likely not installed here.
    let handedOver = false;
    const mark = () => { handedOver = true; };
    window.addEventListener('blur', mark, { once: true });
    document.addEventListener('visibilitychange', mark, { once: true });
    window.location.href = url;
    toast(APP + ' wordt geopend voor ' + fmtId(id));
    setTimeout(() => {
      window.removeEventListener('blur', mark);
      document.removeEventListener('visibilitychange', mark);
      if (!handedOver && document.hasFocus()) noAppHint();
    }, 2500);
  }

  function noAppHint() {
    if ($('#noapp')) return;
    const el = document.createElement('div');
    el.id = 'noapp';
    el.className = 'toast noapp';
    el.innerHTML = `${icon('info', 20)}<div><b>Opent er niets?</b><br>Dan staat ${esc(APP)} nog niet op deze computer.
      <div class="noapp-actions"><a class="btn sm primary" href="/" target="_blank" rel="noopener">${icon('download', 14)} ${esc(APP)} downloaden</a>
      <a class="btn sm" href="#/deploy">Serverinstelling</a></div>
      <small>Installeer de app, plak één keer de serverinstelling (Uitrollen → Configuratie-string) en klik opnieuw op Verbinden.</small></div>
      <button class="icon-btn" aria-label="Sluiten">${icon('x', 16)}</button>`;
    $('#toasts').appendChild(el);
    const close = () => el.parentNode && el.parentNode.removeChild(el);
    $('button', el).onclick = close;
    $$('a', el).forEach(a => a.addEventListener('click', () => setTimeout(close, 100)));
    setTimeout(close, 20000);
  }

  // ---------------- theme ----------------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('nx_theme', t); } catch (e) { /* ignore */ }
  }
  (function () {
    let t = null;
    try { t = localStorage.getItem('nx_theme'); } catch (e) { /* ignore */ }
    if (!t) t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
  })();

  // ---------------- auth ----------------
  function logoutLocal() {
    S.token = null; S.me = null;
    try { localStorage.removeItem('nx_token'); } catch (e) { /* ignore */ }
    renderLogin();
  }

  function renderLogin() {
    clearInterval(S.timer);
    document.title = APP + ' Console';
    $('#root').innerHTML = `
      <div class="login">
        <div class="login-art">
          <div class="brand" style="padding:0"><div class="brand-logo">${icon('arrow', 20)}</div><div><b>${esc(APP)}</b><small>Remote Support Console</small></div></div>
          <h1>Ondersteuning op afstand, volledig in eigen beheer.</h1>
          <p>Beheer je computers, gebruikers en sessies vanuit één console. Je eigen servers, je eigen data.</p>
          <div class="feats"><span>${icon('shield', 16)} End-to-end versleuteld</span><span>${icon('server', 16)} Self-hosted</span><span>${icon('activity', 16)} Sessie-audit</span></div>
          <svg class="deco" width="520" height="520" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width=".6">${ICONS.remote}</svg>
        </div>
        <div class="login-form">
          <form id="lf">
            <h2>Inloggen</h2>
            <p>Log in op de ${esc(APP)} beheerconsole</p>
            <div class="field"><label>Gebruikersnaam</label><input class="input" name="username" autocomplete="username" required autofocus></div>
            <div class="field"><label>Wachtwoord</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
            <button class="btn primary">Inloggen ${icon('arrow', 16)}</button>
            <div class="err-msg"></div>
          </form>
        </div>
      </div>`;
    $('#lf').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      $('.err-msg', f).textContent = '';
      try {
        const r = await api('POST', '/login', { username: f.username.value, password: f.password.value });
        S.token = r.token; S.me = r.user;
        try { localStorage.setItem('nx_token', r.token); } catch (e2) { /* ignore */ }
        if (!location.hash || location.hash === '#/') location.hash = '#/remote';
        renderShell();
      } catch (err) { $('.err-msg', f).textContent = err.message; }
    };
  }

  // ---------------- shell ----------------
  const PAGES = {
    remote: { title: 'Remote Control', icon: 'remote', render: pageRemote },
    computers: { title: 'Computers & Contacten', icon: 'monitor', render: pageComputers },
    sessions: { title: 'Sessies', icon: 'activity', render: pageSessions },
    users: { title: 'Gebruikers', icon: 'users', render: pageUsers, admin: true },
    downloads: { title: 'Downloadportaal', icon: 'download', render: pageDownloads },
    deploy: { title: 'Uitrollen', icon: 'rocket', render: pageDeploy },
    settings: { title: 'Instellingen', icon: 'settings', render: pageSettings },
  };

  function renderShell() {
    const me = S.me;
    $('#root').innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand"><div class="brand-logo">${icon('arrow', 20)}</div><div><b>${esc(APP)}</b><small>Remote Support</small></div></div>
          <nav class="nav">
            <a href="#/remote" data-p="remote">${icon('remote')} Remote Control</a>
            <a href="#/computers" data-p="computers">${icon('monitor')} Computers <span class="count" id="nav-online"></span></a>
            <a href="#/sessions" data-p="sessions">${icon('activity')} Sessies</a>
            <div class="nav-label">Beheer</div>
            ${me.is_admin ? `<a href="#/users" data-p="users">${icon('users')} Gebruikers</a>` : ''}
            <a href="#/downloads" data-p="downloads">${icon('download')} Downloadportaal</a>
            <a href="#/deploy" data-p="deploy">${icon('rocket')} Uitrollen</a>
            <a href="#/settings" data-p="settings">${icon('settings')} Instellingen</a>
          </nav>
          <div class="side-foot">
            <div class="avatar">${esc(initials(me.display_name))}</div>
            <div class="who"><b>${esc(me.display_name)}</b><small>${me.is_admin ? 'Beheerder' : 'Technicus'}</small></div>
            <button class="icon-btn" id="logout" title="Uitloggen">${icon('logout')}</button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <button class="icon-btn menu-btn" id="menu">${icon('menu')}</button>
            <h1 id="page-title"></h1>
            <div class="spacer"></div>
            <button class="icon-btn" id="theme" title="Thema wisselen">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
          </header>
          <main class="content" id="content"></main>
        </div>
      </div>`;
    $('#logout').onclick = async () => { try { await api('POST', '/logout'); } catch (e) { /* ignore */ } logoutLocal(); };
    $('#theme').onclick = () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      $('#theme').innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
    };
    $('#menu').onclick = () => $('.shell').classList.toggle('nav-open');
    route();
  }

  function route() {
    if (!S.me) return;
    clearInterval(S.timer);
    $$('.drawer-wrap').forEach(w => w.remove());
    $('#modal-root').innerHTML = '';
    const key = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'remote';
    const p = PAGES[key] && (!PAGES[key].admin || S.me.is_admin) ? PAGES[key] : PAGES.remote;
    const k = PAGES[key] ? key : 'remote';
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.p === k));
    $('.shell').classList.remove('nav-open');
    $('#page-title').textContent = p.title;
    document.title = p.title + ' · ' + APP;
    $('#content').innerHTML = '';
    p.render($('#content'));
  }
  window.addEventListener('hashchange', route);

  document.addEventListener('click', e => {
    const c = e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); copy(c.dataset.copy); }
    const cn = e.target.closest('[data-connect]');
    if (cn) { e.preventDefault(); e.stopPropagation(); connect(cn.dataset.connect); }
  });

  async function loadDevices() {
    const [d, g] = await Promise.all([api('GET', '/devices'), api('GET', '/groups')]);
    S.devices = d; S.groups = g;
    const on = d.filter(x => x.online).length;
    const el = $('#nav-online'); if (el) el.textContent = on + '/' + d.length;
    return d;
  }

  // ======================= Remote Control =======================
  async function pageRemote(el) {
    el.innerHTML = `
      <div class="hero">
        <h2>Computer op afstand bedienen</h2>
        <p>Voer het ID van de partner in om een verbinding te starten via ${esc(APP)}.</p>
        <form class="hero-row" id="cf">
          <input class="partner-id" id="pid" placeholder="Partner-ID" inputmode="numeric" autocomplete="off">
          <input class="partner-id" id="ppw" type="password" placeholder="Wachtwoord (optioneel)" style="flex:.6;letter-spacing:normal;font-size:16px">
          <button class="btn connect">${icon('arrow', 18)} Verbinden</button>
        </form>
        <div class="hero-opts"><span>${icon('info', 15)} Vereist ${esc(APP)} op deze computer.</span></div>
        <svg class="hero-deco" width="260" height="260" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width=".8">${ICONS.remote}</svg>
      </div>
      <div class="grid g-4" style="margin-top:18px" id="stats"></div>
      <div class="grid g-3" style="margin-top:18px;grid-template-columns:2fr 1fr 1fr" id="row2"></div>
      <div class="grid g-2" style="margin-top:18px" id="row3"></div>`;
    $('#cf').onsubmit = e => { e.preventDefault(); connect($('#pid').value, $('#ppw').value); };
    $('#pid').focus();
    const load = async () => {
      const [st, devs, sess] = await Promise.all([api('GET', '/stats'), loadDevices(), api('GET', '/sessions?limit=8')]);
      $('#stats').innerHTML = [
        ['monitor', st.online, 'Online van ' + st.devices + ' apparaten'],
        ['activity', st.active_sessions, 'Actieve sessies'],
        ['clock', st.sessions_24h, 'Sessies laatste 24 uur'],
        ['users', st.users, 'Gebruikers'],
      ].map(s => `<div class="card stat"><div class="s-ic">${icon(s[0], 22)}</div><div><b>${s[1]}</b><span>${esc(s[2])}</span></div></div>`).join('');
      const max = Math.max(1, ...st.sessions_per_day.map(d => d.count));
      const plat = Object.entries(st.platforms).sort((a, b) => b[1] - a[1]);
      const ptot = plat.reduce((a, b) => a + b[1], 0) || 1;
      $('#row2').innerHTML = `
        <div class="card"><div class="card-h"><h3>Sessies per dag</h3><span class="spacer"></span><span class="muted">14 dagen</span></div>
          <div class="card-b"><div class="bars">${st.sessions_per_day.map(d => `<div style="height:${Math.max(2, d.count / max * 100)}%" data-tip="${esc(d.day.slice(5))}: ${d.count}"></div>`).join('')}</div>
          <div class="bars-x">${st.sessions_per_day.map((d, i) => `<span>${i % 2 ? '' : esc(d.day.slice(8))}</span>`).join('')}</div></div></div>
        <div class="card"><div class="card-h"><h3>Platformen</h3></div><div class="card-b">
          ${plat.length ? plat.map(p => `<div class="plat-row">${icon(osIcon(p[0]), 16)}<span style="width:70px">${esc(p[0])}</span><div class="bar"><i style="width:${p[1] / ptot * 100}%"></i></div><b>${p[1]}</b></div>`).join('') : '<div class="muted">Nog geen apparaten</div>'}
        </div></div>
        <div class="card"><div class="card-h"><h3>Snel starten</h3></div><div class="card-b">
          <a class="btn" style="width:100%;margin-bottom:10px" href="#/deploy">${icon('rocket', 16)} Client uitrollen</a>
          <a class="btn" style="width:100%;margin-bottom:10px" href="#/computers">${icon('plus', 16)} Computer toevoegen</a>
          ${S.me.is_admin ? `<a class="btn" style="width:100%" href="#/users">${icon('users', 16)} Gebruiker toevoegen</a>` : ''}
        </div></div>`;
      const online = devs.filter(d => d.online).slice(0, 8);
      $('#row3').innerHTML = `
        <div class="card"><div class="card-h"><h3>Online computers</h3><span class="spacer"></span><a href="#/computers">Alles bekijken</a></div>
          ${online.length ? `<table class="tbl"><tbody>${online.map(d => `
            <tr><td><div class="dev-name"><div class="dev-ic">${icon(osIcon(d.os))}<span class="dot on"></span></div><div><b>${esc(d.name)}</b><small class="mono">${esc(fmtId(d.id))}</small></div></div></td>
            <td class="hide-sm muted">${esc(d.username || '')}</td>
            <td class="actions"><button class="btn sm primary" data-connect="${esc(d.id)}">${icon('arrow', 14)} Verbinden</button></td></tr>`).join('')}</tbody></table>`
          : `<div class="empty">${icon('monitor', 40)}<div>Geen computers online</div></div>`}
        </div>
        <div class="card"><div class="card-h"><h3>Recente sessies</h3><span class="spacer"></span><a href="#/sessions">Alles bekijken</a></div>
          ${sess.length ? `<table class="tbl"><tbody>${sess.map(s => `
            <tr><td><b>${esc(s.device_name || fmtId(s.device_id))}</b><br><small class="muted">door ${esc(s.peer_name || fmtId(s.peer_id) || s.ip || 'onbekend')}</small></td>
            <td class="hide-sm muted">${esc(s.type_name)}</td>
            <td class="actions">${s.active ? '<span class="badge ok"><span class="dot on"></span>Actief</span>' : `<span class="muted">${ago(s.started_at)}</span>`}</td></tr>`).join('')}</tbody></table>`
          : `<div class="empty">${icon('activity', 40)}<div>Nog geen sessies</div></div>`}
        </div>`;
    };
    try { await load(); } catch (e) { toast(e.message, true); }
    S.timer = setInterval(() => load().catch(() => {}), 15000);
  }

  // ======================= Computers & Contacts =======================
  async function pageComputers(el) {
    el.style.paddingBottom = '20px';
    el.innerHTML = `
      <div class="cc">
        <div class="card cc-groups" id="groups"></div>
        <div class="card cc-list">
          <div class="cc-toolbar">
            <div class="search">${icon('search', 16)}<input class="input" id="q" placeholder="Zoek op naam, ID, gebruiker, IP…" value="${esc(S.q)}"></div>
            <div class="seg" id="seg"><button data-s="all">Alle</button><button data-s="online">Online</button><button data-s="offline">Offline</button></div>
            <button class="btn primary" id="add">${icon('plus', 16)} Computer</button>
          </div>
          <div class="cc-scroll" id="list"></div>
        </div>
      </div>`;
    $('#q').oninput = e => { S.q = e.target.value; drawList(); };
    $$('#seg button').forEach(b => b.onclick = () => { S.filterState = b.dataset.s; drawList(); });
    $('#add').onclick = addDevice;
    const refresh = async () => { await loadDevices(); drawGroups(); drawList(); };
    try { await refresh(); } catch (e) { toast(e.message, true); }
    S.timer = setInterval(() => refresh().catch(() => {}), 10000);
  }

  function drawGroups() {
    const g = $('#groups'); if (!g) return;
    const cnt = id => S.devices.filter(d => id === 'none' ? !d.group_id : d.group_id === id).length;
    const item = (key, label, n, sw, actions) =>
      `<div class="grp ${String(S.filterGroup) === String(key) ? 'active' : ''}" data-g="${key}">${sw}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(label)}</span><span class="n">${n}</span>${actions || ''}</div>`;
    g.innerHTML =
      item('all', 'Alle computers', S.devices.length, icon('monitor', 16)) +
      item('online', 'Online', S.devices.filter(d => d.online).length, '<span class="dot on" style="margin:0 3px"></span>') +
      '<div class="nav-label" style="color:var(--muted);display:flex;align-items:center;padding:14px 10px 6px">Groepen<span style="flex:1"></span><button class="icon-btn" style="width:24px;height:24px" id="addg" title="Groep toevoegen">' + icon('plus', 15) + '</button></div>' +
      S.groups.map(gr => item(gr.id, gr.name, cnt(gr.id), `<span class="sw" style="background:${esc(gr.color)}"></span>`,
        `<span class="grp-act"><button class="icon-btn" style="width:24px;height:24px" data-eg="${gr.id}">${icon('edit', 14)}</button></span>`)).join('') +
      item('none', 'Zonder groep', cnt('none'), icon('folder', 16));
    $$('.grp', g).forEach(x => x.onclick = e => {
      if (e.target.closest('[data-eg]')) return;
      const v = x.dataset.g; S.filterGroup = /^\d+$/.test(v) ? Number(v) : v; drawGroups(); drawList();
    });
    $$('[data-eg]', g).forEach(b => b.onclick = () => editGroup(S.groups.find(x => x.id === Number(b.dataset.eg))));
    $('#addg').onclick = () => editGroup(null);
  }

  function filtered() {
    const q = S.q.trim().toLowerCase().replace(/\s+/g, ' ');
    return S.devices.filter(d => {
      if (S.filterGroup === 'online' && !d.online) return false;
      if (S.filterGroup === 'none' && d.group_id) return false;
      if (typeof S.filterGroup === 'number' && d.group_id !== S.filterGroup) return false;
      if (S.filterState === 'online' && !d.online) return false;
      if (S.filterState === 'offline' && d.online) return false;
      if (q) {
        const hay = [d.id, d.name, d.hostname, d.username, d.ip, d.os, d.group, d.note].join(' ').toLowerCase();
        if (!hay.includes(q) && !d.id.includes(q.replace(/\s/g, ''))) return false;
      }
      return true;
    }).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  }

  function drawList() {
    const l = $('#list'); if (!l) return;
    $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.s === S.filterState));
    const rows = filtered();
    if (!rows.length) {
      l.innerHTML = `<div class="empty">${icon('monitor', 48)}<div style="font-weight:600;color:var(--text);margin-bottom:4px">Geen computers gevonden</div>
        <div>Computers verschijnen automatisch zodra ${esc(APP)} op een computer met deze server verbindt.<br><a href="#/deploy">Bekijk hoe je de client uitrolt →</a></div></div>`;
      return;
    }
    l.innerHTML = `<table class="tbl"><thead><tr><th>Computer</th><th class="hide-sm">Groep</th><th class="hide-sm">Gebruiker</th><th class="hide-sm">Besturingssysteem</th><th class="hide-sm">Laatst gezien</th><th></th></tr></thead><tbody>` +
      rows.map(d => `<tr class="clickable" data-id="${esc(d.id)}">
        <td><div class="dev-name"><div class="dev-ic">${icon(osIcon(d.os))}<span class="dot ${d.online ? 'on' : ''}"></span></div><div><b>${esc(d.name)}</b><small class="mono">${esc(fmtId(d.id))}</small></div></div></td>
        <td class="hide-sm">${d.group ? `<span class="tag"><i style="background:${esc(d.group_color)}"></i>${esc(d.group)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="hide-sm">${esc(d.username || '—')}</td>
        <td class="hide-sm">${esc(osShort(d.os))}</td>
        <td class="hide-sm">${d.online ? `<span class="badge ok">Online${d.conns ? ' · ' + d.conns + ' sessie' + (d.conns > 1 ? 's' : '') : ''}</span>` : `<span class="muted">${ago(d.last_seen)}</span>`}</td>
        <td class="actions"><button class="btn sm ${d.online ? 'primary' : ''}" data-connect="${esc(d.id)}">${icon('arrow', 14)} Verbinden</button></td>
      </tr>`).join('') + '</tbody></table>';
    $$('tr.clickable', l).forEach(tr => tr.onclick = () => openDevice(tr.dataset.id));
  }

  function groupOptions(sel) {
    return '<option value="">— Geen groep —</option>' + S.groups.map(g => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  }

  async function addDevice() {
    await modal('Computer toevoegen', `
      <div class="alert info">${icon('info', 18)}<div>Computers met de client verschijnen automatisch. Handmatig toevoegen is handig om vooraf een naam en groep in te stellen.</div></div>
      <div class="field"><label>ID</label><input class="input mono" name="id" required placeholder="123 456 789"></div>
      <div class="field"><label>Weergavenaam</label><input class="input" name="alias" placeholder="Bijv. Receptie-PC"></div>
      <div class="field"><label>Groep</label><select class="input" name="group_id">${groupOptions(typeof S.filterGroup === 'number' ? S.filterGroup : null)}</select></div>`,
    { ok: 'Toevoegen', onSubmit: async v => { await api('POST', '/devices', { id: v.id, alias: v.alias, group_id: v.group_id ? Number(v.group_id) : null }); toast('Computer toegevoegd'); await loadDevices(); drawGroups(); drawList(); } });
  }

  async function editGroup(g) {
    await modal(g ? 'Groep bewerken' : 'Nieuwe groep', `
      <div class="field"><label>Naam</label><input class="input" name="name" required value="${esc(g ? g.name : '')}"></div>
      <div class="field"><label>Kleur</label>${swatches(g ? g.color : COLORS[0])}</div>
      ${g ? `<button type="button" class="btn danger sm" id="delg">${icon('trash', 14)} Groep verwijderen</button>` : ''}`,
    { ok: g ? 'Opslaan' : 'Aanmaken', onSubmit: async v => {
      if (g) await api('PATCH', '/groups/' + g.id, v); else await api('POST', '/groups', v);
      toast(g ? 'Groep bijgewerkt' : 'Groep aangemaakt'); await loadDevices(); drawGroups(); drawList();
    } });
  }
  document.addEventListener('click', async e => {
    if (e.target.closest('#delg')) {
      const name = $('#modal-root [name=name]').value;
      const g = S.groups.find(x => x.name === name);
      $('#modal-root').innerHTML = '';
      if (!g) return;
      if (await confirmBox('Groep verwijderen', `Groep "${g.name}" verwijderen? Computers blijven bestaan maar worden losgekoppeld.`)) {
        await api('DELETE', '/groups/' + g.id); if (S.filterGroup === g.id) S.filterGroup = 'all';
        toast('Groep verwijderd'); await loadDevices(); drawGroups(); drawList();
      }
    }
  });

  function openDevice(id) {
    const d = S.devices.find(x => x.id === id); if (!d) return;
    const wrap = document.createElement('div');
    wrap.className = 'drawer-wrap';
    wrap.innerHTML = `<div class="drawer-bg"></div><aside class="drawer">
      <div class="drawer-h"><div class="dev-ic" style="width:52px;height:52px;border-radius:12px">${icon(osIcon(d.os), 26)}<span class="dot ${d.online ? 'on' : ''}"></span></div>
        <div style="flex:1;min-width:0"><h3 style="font-size:18px">${esc(d.name)}</h3><div class="big-id mono">${esc(fmtId(d.id))}</div>
        <div style="margin-top:6px">${d.online ? '<span class="badge ok"><span class="dot on"></span>Online</span>' : `<span class="badge">Offline · ${ago(d.last_seen)}</span>`}</div></div>
        <button class="icon-btn" data-close>${icon('x')}</button></div>
      <div class="drawer-b">
        <div style="display:flex;gap:10px;margin-bottom:22px">
          <button class="btn primary" style="flex:1" data-connect="${esc(d.id)}">${icon('arrow', 16)} Verbinden</button>
          <button class="btn" data-copy="${esc(d.id)}">${icon('copy', 16)} ID</button>
        </div>
        <form id="df">
          <div class="field"><label>Weergavenaam</label><input class="input" name="alias" value="${esc(d.alias)}" placeholder="${esc(d.hostname || d.id)}"></div>
          <div class="field"><label>Groep</label><select class="input" name="group_id">${groupOptions(d.group_id)}</select></div>
          <div class="field"><label>Notities</label><textarea class="input" name="note" placeholder="Bijv. locatie, contactpersoon…">${esc(d.note)}</textarea></div>
        </form>
        <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:8px 0 12px">Systeeminformatie</h3>
        <dl class="kv">
          <dt>Hostnaam</dt><dd>${esc(d.hostname || '—')}</dd>
          <dt>Gebruiker</dt><dd>${esc(d.username || '—')}</dd>
          <dt>Besturingssysteem</dt><dd>${esc(d.os || '—')}</dd>
          <dt>Processor</dt><dd>${esc(d.cpu || '—')}</dd>
          <dt>Geheugen</dt><dd>${esc(d.memory || '—')}</dd>
          <dt>Client versie</dt><dd>${esc(d.version || '—')}</dd>
          <dt>IP-adres</dt><dd class="mono">${esc(d.ip || '—')}</dd>
          <dt>Eerst gezien</dt><dd>${dt(d.created_at)}</dd>
          <dt>Laatst gezien</dt><dd>${dt(d.last_seen)}</dd>
        </dl>
      </div>
      <div class="drawer-f">
        ${S.me.is_admin ? `<button class="btn danger" id="ddel">${icon('trash', 16)}</button>` : ''}
        <span style="flex:1"></span><button class="btn" data-close>Sluiten</button><button class="btn primary" id="dsave">Opslaan</button>
      </div></aside>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    $$('[data-close]', wrap).forEach(b => b.onclick = close);
    $('.drawer-bg', wrap).onclick = close;
    $('#dsave', wrap).onclick = async () => {
      const f = $('#df', wrap);
      try {
        await api('PATCH', '/devices/' + encodeURIComponent(d.id), { alias: f.alias.value, note: f.note.value, group_id: f.group_id.value ? Number(f.group_id.value) : null });
        toast('Computer bijgewerkt'); close(); await loadDevices(); drawGroups(); drawList();
      } catch (e) { toast(e.message, true); }
    };
    const del = $('#ddel', wrap);
    if (del) del.onclick = async () => {
      if (await confirmBox('Computer verwijderen', `"${d.name}" (${fmtId(d.id)}) verwijderen uit de console? Als de client nog actief is, verschijnt hij vanzelf weer.`)) {
        await api('DELETE', '/devices/' + encodeURIComponent(d.id)); toast('Computer verwijderd'); close(); await loadDevices(); drawGroups(); drawList();
      }
    };
  }

  // ======================= Sessions =======================
  async function pageSessions(el) {
    el.innerHTML = `<div class="card"><div class="tabs"><button class="on" data-t="conn">${icon('activity', 16)} Verbindingen</button><button data-t="file">${icon('file', 16)} Bestandsoverdracht</button></div><div id="sess"></div></div>`;
    let tab = 'conn';
    $$('.tabs button', el).forEach(b => b.onclick = () => { tab = b.dataset.t; $$('.tabs button', el).forEach(x => x.classList.toggle('on', x === b)); load(); });
    const load = async () => {
      const box = $('#sess'); if (!box) return;
      if (tab === 'conn') {
        const rows = await api('GET', '/sessions?limit=500');
        box.innerHTML = rows.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Status</th><th>Computer</th><th>Verbonden door</th><th class="hide-sm">Type</th><th class="hide-sm">IP-adres</th><th>Gestart</th><th class="hide-sm">Duur</th><th></th></tr></thead><tbody>` +
          rows.map(s => `<tr>
            <td>${s.active ? '<span class="badge ok"><span class="dot on"></span>Actief</span>' : '<span class="badge">Beëindigd</span>'}</td>
            <td><b>${esc(s.device_name || fmtId(s.device_id))}</b><br><small class="mono muted">${esc(fmtId(s.device_id))}</small></td>
            <td>${esc(s.peer_name || '—')}<br><small class="mono muted">${esc(fmtId(s.peer_id))}</small></td>
            <td class="hide-sm">${esc(s.type_name)}</td>
            <td class="hide-sm mono">${esc(s.ip || '—')}</td>
            <td>${dt(s.started_at)}</td>
            <td class="hide-sm">${dur(s.started_at, s.ended_at)}</td>
            <td class="actions">${s.active ? `<button class="btn sm danger" data-disc="${s.pk}">${icon('power', 14)} Verbreken</button>` : ''}</td></tr>`).join('') + '</tbody></table></div>'
          : `<div class="empty">${icon('activity', 48)}<div>Nog geen sessies geregistreerd.</div></div>`;
        $$('[data-disc]', box).forEach(b => b.onclick = async () => {
          if (!await confirmBox('Sessie verbreken', 'Deze sessie geforceerd verbreken?', 'Verbreken')) return;
          try { const r = await api('POST', '/sessions/' + b.dataset.disc + '/disconnect'); toast(r.message); } catch (e) { toast(e.message, true); }
        });
      } else {
        const rows = await api('GET', '/files');
        box.innerHTML = rows.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Tijd</th><th>Computer</th><th>Door</th><th>Richting</th><th>Pad</th></tr></thead><tbody>` +
          rows.map(f => `<tr><td>${dt(f.created_at)}</td><td class="mono">${esc(fmtId(f.device_id))}</td><td class="mono">${esc(fmtId(f.peer_id))}</td>
            <td>${f.type === 0 ? 'Naar computer' : f.type === 1 ? 'Van computer' : esc(f.type)}</td><td class="mono" style="word-break:break-all">${esc(f.path)}</td></tr>`).join('') + '</tbody></table></div>'
          : `<div class="empty">${icon('file', 48)}<div>Nog geen bestandsoverdrachten.</div></div>`;
      }
    };
    try { await load(); } catch (e) { toast(e.message, true); }
    S.timer = setInterval(() => load().catch(() => {}), 10000);
  }

  // ======================= Users =======================
  async function pageUsers(el) {
    el.innerHTML = `<div class="card"><div class="card-h"><h3>Gebruikers</h3><span class="muted" id="ucount"></span><span class="spacer"></span><button class="btn primary" id="uadd">${icon('plus', 16)} Gebruiker</button></div><div id="ulist"></div></div>
      <div class="alert info" style="margin-top:18px">${icon('info', 18)}<div>Gebruikers loggen in ${esc(APP)} in via <b>Instellingen → Account</b>. Ze zien dan alle beheerde computers onder <b>Toegankelijke apparaten</b> en hun persoonlijke adresboek wordt gesynchroniseerd. Met <b>Sync adresboek</b> zet je alle computers (met groep als tag) in het adresboek van een gebruiker.</div></div>`;
    const load = async () => {
      const users = await api('GET', '/users');
      $('#ucount').textContent = users.length + ' totaal';
      $('#ulist').innerHTML = `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Gebruiker</th><th>Rol</th><th class="hide-sm">Status</th><th class="hide-sm">Clients</th><th class="hide-sm">Adresboek</th><th class="hide-sm">Laatste login</th><th></th></tr></thead><tbody>` +
        users.map(u => `<tr>
          <td><div class="dev-name"><div class="avatar">${esc(initials(u.display_name))}</div><div><b>${esc(u.display_name)}</b><small>${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}</small></div></div></td>
          <td>${u.is_admin ? '<span class="badge brand">Beheerder</span>' : '<span class="badge">Technicus</span>'}</td>
          <td class="hide-sm">${u.status ? '<span class="badge ok">Actief</span>' : '<span class="badge warn">Uitgeschakeld</span>'}</td>
          <td class="hide-sm">${u.clients}</td>
          <td class="hide-sm">${u.ab_peers} items</td>
          <td class="hide-sm">${ago(u.last_login)}</td>
          <td class="actions">
            <button class="btn sm ghost" data-sync="${u.id}" title="Sync alle computers naar adresboek">${icon('sync', 14)} Sync adresboek</button>
            <button class="btn sm ghost" data-edit="${u.id}">${icon('edit', 14)}</button>
            ${u.id !== S.me.id ? `<button class="btn sm ghost danger" data-del="${u.id}">${icon('trash', 14)}</button>` : ''}
          </td></tr>`).join('') + '</tbody></table></div>';
      $$('[data-edit]', el).forEach(b => b.onclick = () => editUser(users.find(u => u.id === Number(b.dataset.edit)), load));
      $$('[data-del]', el).forEach(b => b.onclick = async () => {
        const u = users.find(x => x.id === Number(b.dataset.del));
        if (await confirmBox('Gebruiker verwijderen', `Gebruiker "${u.username}" en het bijbehorende adresboek verwijderen?`)) {
          await api('DELETE', '/users/' + u.id); toast('Gebruiker verwijderd'); load();
        }
      });
      $$('[data-sync]', el).forEach(b => b.onclick = async () => {
        try { const r = await api('POST', '/users/' + b.dataset.sync + '/sync-ab'); toast(`Adresboek bijgewerkt: ${r.added} toegevoegd, ${r.total} totaal`); load(); }
        catch (e) { toast(e.message, true); }
      });
    };
    $('#uadd').onclick = () => editUser(null, load);
    try { await load(); } catch (e) { toast(e.message, true); }
  }

  async function editUser(u, after) {
    await modal(u ? 'Gebruiker bewerken' : 'Nieuwe gebruiker', `
      <div class="field"><label>Gebruikersnaam</label><input class="input" name="username" ${u ? 'disabled' : 'required'} value="${esc(u ? u.username : '')}"></div>
      <div class="field"><label>Weergavenaam</label><input class="input" name="display_name" value="${esc(u ? u.display_name : '')}"></div>
      <div class="field"><label>E-mail</label><input class="input" type="email" name="email" value="${esc(u ? u.email : '')}"></div>
      <div class="field"><label>${u ? 'Nieuw wachtwoord (leeg = ongewijzigd)' : 'Wachtwoord'}</label><input class="input" type="password" name="password" autocomplete="new-password" ${u ? '' : 'required minlength="8"'}></div>
      <label class="check" style="margin-bottom:10px"><input type="checkbox" name="is_admin" ${u && u.is_admin ? 'checked' : ''}> Beheerder (mag gebruikers en instellingen beheren)</label>
      ${u ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" name="status" ${u.status ? 'checked' : ''}> Account actief</label>` : ''}`,
    { ok: u ? 'Opslaan' : 'Aanmaken', onSubmit: async v => {
      if (u) {
        const body = { display_name: v.display_name, email: v.email, is_admin: v.is_admin, status: v.status ? 1 : 0 };
        if (v.password) body.password = v.password;
        await api('PATCH', '/users/' + u.id, body);
      } else await api('POST', '/users', v);
      toast(u ? 'Gebruiker bijgewerkt' : 'Gebruiker aangemaakt'); after();
    } });
  }

  // ======================= Download portal =======================
  async function pageDownloads(el) {
    const mb = b => b ? (b / 1048576).toFixed(1) + ' MB' : '—';
    const load = async (first) => {
      const d = await api('GET', '/installers');
      const portalUrl = d.public_url || location.origin;
      const admin = S.me.is_admin;
      if (first) {
        el.innerHTML = `
          <div id="dl-alert"></div>
          <div class="grid g-4" id="dl-stats"></div>
          <div class="card" style="margin-top:18px"><div class="card-h">${icon('download', 18)}<h3>Installers</h3><span class="muted" id="sync-state"></span><span class="spacer"></span>
            ${admin ? `<label class="check" style="font-size:13px"><input type="checkbox" id="auto"> Automatisch bijwerken</label>
            <button class="btn sm" id="sync">${icon('sync', 14)} Nu bijwerken</button>` : ''}</div><div id="dl-table"></div></div>
          <div class="grid g-2" style="margin-top:18px">
            <div class="card"><div class="card-h">${icon('globe', 18)}<h3>Portaal</h3><span class="spacer"></span><a class="btn sm" id="open-portal" target="_blank" rel="noopener">${icon('external', 14)} Openen</a></div><div class="card-b">
              <form id="pf">
                <div class="field"><label>Publieke URL</label><input class="input" name="public_url" placeholder="https://support.richrdj.nl"><span class="hint">Wordt ook gebruikt als API-server voor de ${esc(APP)}-apps.</span></div>
                <div class="field"><label>Productnaam</label><input class="input" name="app_name" placeholder="DeskHop"><span class="hint">Naam van de app en van de downloads (bijv. DeskHop.dmg).</span></div>
                <div class="field"><label>Bedrijfsnaam</label><input class="input" name="company"></div>
                <div class="field"><label>Titel</label><input class="input" name="title"></div>
                <div class="field"><label>Introductietekst</label><textarea class="input" name="intro"></textarea></div>
                <div class="grid g-2" style="gap:12px"><div class="field"><label>Telefoon</label><input class="input" name="phone" placeholder="+31 6 …"></div>
                <div class="field"><label>E-mail</label><input class="input" name="email" placeholder="support@…"></div></div>
                <div class="field"><label>Versie vastzetten (optioneel)</label><input class="input" name="pinned" placeholder="leeg = altijd nieuwste, bijv. 1.5.3"></div>
                ${admin ? '<button class="btn primary">Opslaan</button>' : ''}
              </form></div></div>
            <div class="card"><div class="card-h">${icon('activity', 18)}<h3>Recente downloads</h3></div><div id="dl-recent"></div></div>
          </div>`;
        const f = $('#pf');
        ['public_url', 'company', 'title', 'intro', 'phone', 'email'].forEach(k => { f[k].value = k === 'public_url' ? d.public_url : (d.portal[k] || ''); });
        f.app_name.value = d.app_name || '';
        f.pinned.value = d.pinned || '';
        if (!admin) $$('input,textarea', f).forEach(i => i.disabled = true);
        f.onsubmit = async e => {
          e.preventDefault();
          const v = {}; ['public_url', 'app_name', 'company', 'title', 'intro', 'phone', 'email', 'pinned'].forEach(k => v[k] = f[k].value);
          try { await api('PUT', '/portal', v); toast('Portaal opgeslagen'); load(); } catch (err) { toast(err.message, true); }
        };
        if (admin) {
          $('#auto').checked = d.auto;
          $('#auto').onchange = async e => { await api('PUT', '/portal', { auto: e.target.checked }); toast('Opgeslagen'); };
          $('#sync').onclick = async () => { const r = await api('POST', '/installers/sync', { force: false }); toast(r.message); setTimeout(load, 800); };
        }
      }
      $('#open-portal').href = portalUrl;
      const s = d.sync;
      $('#sync-state').innerHTML = s.running ? `<span class="badge brand">${icon('sync', 12)} ${esc(s.progress || 'Bezig…')}</span>`
        : s.last_error ? `<span class="badge warn" title="${esc(s.last_error)}">Fout bij bijwerken</span>` : (d.latest ? 'Nieuwste versie: v' + esc(d.latest) : '');
      $('#dl-alert').innerHTML = '';
      const avail = d.platforms.filter(p => p.enabled && p.available).length;
      $('#dl-stats').innerHTML = [
        ['globe', `<a href="${esc(portalUrl)}" target="_blank" rel="noopener" style="font-size:15px">${esc(portalUrl.replace(/^https?:\/\//, ''))}</a>`, 'Publiek downloadportaal'],
        ['download', d.downloads_30d, 'Downloads laatste 30 dagen'],
        ['monitor', avail + '/' + d.platforms.filter(p => p.enabled).length, 'Installers beschikbaar'],
        ['shield', d.server.filename_ok ? 'Aan' : 'Uit', 'Windows-autoconfiguratie'],
      ].map(x => `<div class="card stat"><div class="s-ic">${icon(x[0], 22)}</div><div style="min-width:0"><b>${x[1]}</b><span>${esc(x[2])}</span></div></div>`).join('');
      $('#dl-table').innerHTML = `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Tonen</th><th>Platform</th><th>Bestand</th><th class="hide-sm">Bron</th><th class="hide-sm">Grootte</th><th class="hide-sm">Downloads</th><th></th></tr></thead><tbody>` +
        d.platforms.map(p => `<tr>
          <td><label class="check"><input type="checkbox" data-en="${p.key}" ${p.enabled ? 'checked' : ''} ${admin ? '' : 'disabled'}></label></td>
          <td><b>${esc(p.label)}</b><br><small class="muted">${esc(p.arch)}</small></td>
          <td>${p.available ? `<span class="mono" style="font-size:12.5px" title="${esc(p.file)}">${esc(p.file.includes("--") ? p.file.split("--")[0] + "--….exe" : p.file)}</span><br><small class="muted">v${esc(p.version)}</small>` : `<span class="muted">${p.enabled ? 'Nog niet gedownload' : '—'}</span>`}</td>
          <td class="hide-sm">${p.key === 'win_msi' ? '<span class="badge warn" title="Niet zichtbaar voor klanten, wel voor je uitrolscripts">Alleen uitrol</span> ' : ''}${p.source === 'upload' ? '<span class="badge brand">Eigen upload</span>' : p.source === 'github' ? '<span class="badge">Automatisch</span>' : ''}</td>
          <td class="hide-sm">${p.available ? mb(p.size) : '—'}</td>
          <td class="hide-sm">${p.downloads}</td>
          <td class="actions">
            ${p.available ? `<a class="btn sm ghost" href="${esc(p.url)}" title="Downloaden">${icon('download', 14)}</a>` : ''}
            ${admin ? `<button class="btn sm ghost" data-up="${p.key}" title="Eigen installer uploaden">${icon('upload', 14)} Upload</button>` : ''}
            ${admin && p.has_upload ? `<button class="btn sm ghost danger" data-rmup="${p.key}" title="Eigen upload verwijderen">${icon('trash', 14)}</button>` : ''}
          </td></tr>`).join('') + '</tbody></table></div>';
      $$('[data-en]', el).forEach(c => c.onchange = async () => {
        await api('PATCH', '/installers/' + c.dataset.en, { enabled: c.checked });
        toast(c.checked ? 'Platform zichtbaar op portaal' : 'Platform verborgen');
        if (c.checked) await api('POST', '/installers/sync', {});
        load();
      });
      $$('[data-up]', el).forEach(b => b.onclick = () => {
        const inp = document.createElement('input'); inp.type = 'file';
        inp.onchange = async () => {
          const file = inp.files[0]; if (!file) return;
          b.disabled = true; b.innerHTML = icon('sync', 14) + ' Uploaden…';
          try {
            const r = await fetch('/console-api/installers/' + b.dataset.up + '/upload?filename=' + encodeURIComponent(file.name),
              { method: 'PUT', headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/octet-stream' }, body: file });
            if (!r.ok) throw new Error((await r.json()).error || 'Upload mislukt');
            toast('Installer geüpload'); load();
          } catch (e) { toast(e.message, true); b.disabled = false; }
        };
        inp.click();
      });
      $$('[data-rmup]', el).forEach(b => b.onclick = async () => {
        if (await confirmBox('Eigen upload verwijderen', 'De eigen installer verwijderen? Het portaal gebruikt dan weer de automatisch bijgewerkte versie.')) {
          await api('DELETE', '/installers/' + b.dataset.rmup + '/upload'); toast('Upload verwijderd'); load();
        }
      });
      $('#dl-recent').innerHTML = d.recent.length ? `<table class="tbl"><tbody>${d.recent.map(r => {
        const p = d.platforms.find(x => x.key === r.platform);
        return `<tr><td><b>${esc(p ? p.label : r.platform)}</b><br><small class="muted mono">${esc(r.ip)}</small></td><td class="muted" style="text-align:right">${ago(r.created_at)}</td></tr>`;
      }).join('')}</tbody></table>` : `<div class="empty">${icon('download', 40)}<div>Nog geen downloads</div></div>`;
      if (s.running) { clearInterval(S.timer); S.timer = setInterval(() => load().catch(() => {}), 2500); }
      else { clearInterval(S.timer); S.timer = setInterval(() => load().catch(() => {}), 20000); }
    };
    try { await load(true); } catch (e) { toast(e.message, true); }
  }

  // ======================= Deploy =======================
  async function pageDeploy(el) {
    let info;
    try { info = await api('GET', '/deploy'); } catch (e) { toast(e.message, true); return; }
    const missing = !info.host || !info.key;
    el.innerHTML = `
      ${missing ? `<div class="alert">${icon('info', 18)}<div><b>Configuratie incompleet.</b> ${!info.host ? 'Er is nog geen publiek serveradres ingesteld. ' : ''}${!info.key ? 'De publieke key van de ID-server is nog niet gevonden (start de stack volledig op). ' : ''}Stel dit in via ${S.me.is_admin ? '<a href="#/settings">Instellingen</a>' : 'een beheerder'}.</div></div>` : ''}
      <div class="grid g-2">
        <div class="card"><div class="card-h">${icon('server', 18)}<h3>Serverconfiguratie</h3></div><div class="card-b">
          <div class="field"><label>ID-server</label>${codebox(info.host)}</div>
          <div class="field"><label>Relay-server</label>${codebox(info.relay || (info.host ? info.host + ' (standaard)' : ''))}</div>
          <div class="field"><label>API-server</label>${codebox(info.api)}</div>
          <div class="field"><label>Key</label>${codebox(info.key)}</div>
        </div></div>
        <div class="card"><div class="card-h">${icon('key', 18)}<h3>Configuratie-string</h3></div><div class="card-b">
          <p class="muted" style="margin-top:0">Kopieer deze string en plak hem in ${esc(APP)} via <b>Instellingen → Netwerk → ID/Relay-server → importeren</b> (klembord-icoon). Alle velden worden dan in één keer ingevuld.</p>
          ${codebox(info.config_string)}
          <h3 style="font-size:14px;margin:22px 0 8px">Windows: zelfconfigurerende download</h3>
          <p class="muted" style="margin-top:0">De Windows-download van het portaal heeft deze naam. Daarin zit de serverconfiguratie, zodat de app zichzelf instelt. Hernoem het bestand dus niet.</p>
          ${codebox(info.filename_windows)}
        </div></div>
      </div>
      <div class="card" style="margin-top:18px"><div class="tabs" id="dtabs">
        <button class="on" data-t="win">${icon('windows', 16)} Windows</button><button data-t="mac">${icon('apple', 16)} macOS</button></div>
        <div class="card-b" id="dbody"></div></div>`;
    const portal = info.public_url || location.origin;
    const ps = `$ErrorActionPreference = 'Stop'
$portal = '${portal}'
$cfg = '${info.config_string}'
Invoke-WebRequest "$portal/download/win_msi" -OutFile "$env:TEMP\\support.msi"
Start-Process msiexec.exe -ArgumentList '/i', "$env:TEMP\\support.msi", '/qn' -Wait
Start-Sleep 10
$app = Get-ChildItem "$env:ProgramFiles" -Filter '*.exe' -Recurse -Depth 1 | Where-Object { $_.VersionInfo.FileDescription -match 'Remote' } | Select-Object -First 1 -ExpandProperty FullName
& $app --config $cfg
# Optioneel vast wachtwoord voor onbeheerde toegang:
# & $app --password 'JouwSterkWachtwoord'
& $app --get-id | Write-Output`;
    const T = {
      win: `<ol class="steps">
        <li><b>Snel (handmatig):</b> laat de gebruiker <a href="${esc(portal)}" target="_blank" rel="noopener">${esc(portal.replace(/^https?:\/\//, ''))}</a> openen en op Downloaden klikken. De app stelt zichzelf in.</li>
        <li><b>Gescript (PowerShell als administrator, bijv. via Intune/GPO/RMM):</b> installeert de MSI vanaf je eigen portaal en configureert hem.${codebox(ps)}</li>
        <li>De computer verschijnt binnen ~15 seconden in <a href="#/computers">Computers</a>.</li></ol>`,
      mac: `<ol class="steps"><li>Download de app via <a href="${esc(portal)}" target="_blank" rel="noopener">${esc(portal.replace(/^https?:\/\//, ''))}</a> (Apple-chip of Intel wordt automatisch gekozen).</li>
        <li>Installeer en geef bij de eerste start toestemming voor <i>Schermopname</i> en <i>Toegankelijkheid</i>.</li>
        <li>Open Instellingen → Netwerk → ID/Relay-server, klik op het import-icoon en plak de configuratie-string hierboven.</li></ol>`,
    };
    const show = t => { $$('#dtabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); $('#dbody').innerHTML = T[t]; };
    $$('#dtabs button').forEach(b => b.onclick = () => show(b.dataset.t));
    show('win');
  }

  // ======================= Settings =======================
  async function pageSettings(el) {
    el.innerHTML = `<div class="grid g-2" id="sg"></div>`;
    const g = $('#sg');
    let html = `<div class="card"><div class="card-h">${icon('user', 18)}<h3>Mijn account</h3></div><div class="card-b">
      <dl class="kv"><dt>Gebruikersnaam</dt><dd>${esc(S.me.username)}</dd><dt>Rol</dt><dd>${S.me.is_admin ? 'Beheerder' : 'Technicus'}</dd></dl>
      <form id="pwf"><div class="field"><label>Huidig wachtwoord</label><input class="input" type="password" name="current" required autocomplete="current-password"></div>
      <div class="field"><label>Nieuw wachtwoord</label><input class="input" type="password" name="new" required minlength="8" autocomplete="new-password"></div>
      <button class="btn primary">Wachtwoord wijzigen</button></form></div></div>`;
    if (S.me.is_admin) {
      html += `<div class="card"><div class="card-h">${icon('server', 18)}<h3>Server</h3></div><div class="card-b"><form id="srvf">
        <div class="field"><label>Adres ID-server</label><input class="input" name="host" placeholder="rd.bedrijf.nl"><span class="hint" id="h-host"></span></div>
        <div class="field"><label>Relay-server</label><input class="input" name="relay" placeholder="leeg = zelfde adres als ID-server"><span class="hint" id="h-relay"></span></div>
        <div class="field"><label>API-server</label><input class="input" name="api" placeholder="leeg = publieke URL van het portaal"><span class="hint" id="h-api"></span></div>
        <div class="field"><label>Publieke key (override)</label><input class="input mono" name="key" placeholder="leeg = automatisch van de ID-server"><span class="hint" id="h-key"></span></div>
        <button class="btn primary">Opslaan</button></form></div></div>
        <div class="card"><div class="card-h">${icon('shield', 18)}<h3>HTTPS-certificaat</h3><span class="spacer"></span><span id="tls-badge"></span></div><div class="card-b">
          <p class="muted" style="margin-top:0">Optioneel: laat de console zelf HTTPS doen op poort 21114 (geen 443 nodig). Niet nodig als je een Cloudflare Tunnel of reverse proxy gebruikt.</p>
          <div id="tls-info"></div>
          <form id="tlsf">
            <div class="field"><label>Certificaat (fullchain.pem)</label><textarea class="input mono" name="cert" placeholder="-----BEGIN CERTIFICATE-----" style="font-size:12px"></textarea></div>
            <div class="field"><label>Private key (privkey.pem)</label><textarea class="input mono" name="key" placeholder="-----BEGIN PRIVATE KEY-----" style="font-size:12px"></textarea></div>
            <div style="display:flex;gap:10px"><button class="btn primary">Certificaat opslaan</button><button type="button" class="btn danger" id="tls-del">Verwijderen</button></div>
          </form></div></div>
        <div class="card" style="grid-column:1/-1"><div class="card-h">${icon('key', 18)}<h3>Actieve logins</h3><span class="spacer"></span><span class="muted">Console- en client-sessies</span></div><div id="toks"></div></div>`;
    }
    g.innerHTML = html;
    $('#pwf').onsubmit = async e => {
      e.preventDefault();
      try { await api('POST', '/me/password', { current: e.target.current.value, new: e.target.new.value }); toast('Wachtwoord gewijzigd'); e.target.reset(); }
      catch (err) { toast(err.message, true); }
    };
    if (!S.me.is_admin) return;
    const st = await api('GET', '/settings');
    const f = $('#srvf');
    ['host', 'relay', 'api', 'key'].forEach(k => { f[k].value = st[k] || ''; });
    $('#h-host').textContent = 'DNS-naam die direct naar je server wijst (poorten 21115–21117). Leeg = hostnaam van de publieke URL.';
    $('#h-relay').textContent = '';
    $('#h-api').textContent = 'Wordt standaard afgeleid van de publieke URL (Downloadportaal).';
    $('#h-key').textContent = 'Wordt automatisch gelezen; alleen invullen als je een eigen key gebruikt.';
    const showTls = t => {
      $('#tls-badge').innerHTML = t.active ? '<span class="badge ok">Actief</span>' : t.configured ? '<span class="badge warn">Herstart nodig</span>' : '<span class="badge">Uit</span>';
      $('#tls-info').innerHTML = t.configured ? `<dl class="kv"><dt>Domeinen</dt><dd>${esc((t.names || []).join(', ') || t.subject || '—')}</dd><dt>Geldig tot</dt><dd>${esc(t.not_after || '—')}</dd></dl>` : '';
      $('#tls-del').style.display = t.configured ? '' : 'none';
    };
    showTls(await api('GET', '/tls'));
    $('#tlsf').onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('PUT', '/tls', { cert: e.target.cert.value, key: e.target.key.value }); toast(r.message); e.target.reset(); showTls(r); }
      catch (err) { toast(err.message, true); }
    };
    $('#tls-del').onclick = async () => {
      if (!await confirmBox('Certificaat verwijderen', 'Het HTTPS-certificaat verwijderen? Na een herstart draait de console weer op HTTP.')) return;
      const r = await api('DELETE', '/tls'); toast(r.message); showTls(r);
    };
    f.onsubmit = async e => {
      e.preventDefault();
      try { await api('PUT', '/settings', { host: f.host.value, relay: f.relay.value, api: f.api.value, key: f.key.value }); toast('Instellingen opgeslagen'); }
      catch (err) { toast(err.message, true); }
    };
    const toks = await api('GET', '/tokens');
    $('#toks').innerHTML = toks.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Gebruiker</th><th>Type</th><th>Apparaat</th><th class="hide-sm">IP</th><th>Laatst actief</th></tr></thead><tbody>` +
      toks.map(t => `<tr><td>${esc(t.username)}</td><td>${t.kind === 'web' ? '<span class="badge brand">Console</span>' : '<span class="badge">' + esc(APP) + '</span>'}</td>
        <td>${esc(t.device_id ? fmtId(t.device_id) + ' · ' : '')}<span class="muted">${esc(t.device_name)}</span></td><td class="hide-sm mono">${esc(t.ip)}</td><td>${ago(t.last_used)}</td></tr>`).join('') + '</tbody></table></div>'
      : '<div class="empty">Geen actieve logins</div>';
  }

  // ---------------- first-run setup ----------------
  function renderSetup() {
    document.title = 'Installatie · ' + APP;
    $('#root').innerHTML = `
      <div class="login">
        <div class="login-art">
          <div class="brand" style="padding:0"><div class="brand-logo">${icon('arrow', 20)}</div><div><b>${esc(APP)}</b><small>Eerste installatie</small></div></div>
          <h1>Welkom! Nog even een paar gegevens.</h1>
          <p>Alles wat je hier invult kun je later aanpassen onder Instellingen en Downloadportaal. Er zijn geen environment-variabelen nodig.</p>
          <div class="feats"><span>${icon('shield', 16)} Je eerste account wordt beheerder</span></div>
        </div>
        <div class="login-form" style="overflow:auto">
          <form id="sf" style="width:420px">
            <h2>Installatie</h2>
            <p>Maak je beheerdersaccount aan en stel je server in.</p>
            <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:4px 0 12px">Beheerder</h3>
            <div class="grid g-2" style="gap:12px">
              <div class="field"><label>Gebruikersnaam</label><input class="input" name="username" value="admin" required autocomplete="username"></div>
              <div class="field"><label>Naam</label><input class="input" name="display_name" placeholder="Je naam"></div>
            </div>
            <div class="field"><label>Wachtwoord</label><input class="input" type="password" name="password" required minlength="10" autocomplete="new-password"><span class="hint">Minimaal 10 tekens</span></div>
            <div class="field"><label>Herhaal wachtwoord</label><input class="input" type="password" name="password2" required autocomplete="new-password"></div>
            <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 12px">Server</h3>
            <div class="grid g-2" style="gap:12px">
              <div class="field"><label>Productnaam</label><input class="input" name="app_name" value="${esc(APP)}"></div>
              <div class="field"><label>Bedrijfsnaam</label><input class="input" name="company" placeholder="Bijv. RichrdJ Support"></div>
            </div>
            <div class="field"><label>Publieke URL van het portaal</label><input class="input" name="public_url" value="${esc(location.origin)}" required><span class="hint">Waar klanten de download vinden, bijv. https://support.richrdj.nl</span></div>
            <div class="field"><label>Adres ID-server</label><input class="input" name="host" value="${esc(location.hostname)}" required><span class="hint">DNS-naam of IP die <b>direct</b> naar deze server wijst (poorten 21115–21117)</span></div>
            <button class="btn primary">Installatie afronden ${icon('arrow', 16)}</button>
            <div class="err-msg"></div>
          </form>
        </div>
      </div>`;
    $('#sf').onsubmit = async e => {
      e.preventDefault();
      const f = e.target; $('.err-msg', f).textContent = '';
      if (f.password.value !== f.password2.value) { $('.err-msg', f).textContent = 'De wachtwoorden zijn niet gelijk'; return; }
      const body = {}; ['username', 'display_name', 'password', 'app_name', 'company', 'public_url', 'host'].forEach(k => body[k] = f[k].value);
      try {
        const r = await api('POST', '/setup', body);
        try { localStorage.setItem('nx_token', r.token); } catch (e2) { /* ignore */ }
        location.hash = '#/downloads'; location.reload();
      } catch (err) { $('.err-msg', f).textContent = err.message; }
    };
  }

  // ---------------- boot ----------------
  (async function boot() {
    try { const m = await fetch('/console-api/meta').then(r => r.json()); if (m.setup) return renderSetup(); } catch (e) { /* ignore */ }
    if (!S.token) return renderLogin();
    try { S.me = await api('GET', '/me'); renderShell(); }
    catch (e) { if (S.token) logoutLocal(); }
  })();
})();
