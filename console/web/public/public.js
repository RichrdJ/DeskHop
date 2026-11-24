(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Icons live in the SVG sprite at the top of index.html.
  const ic = n => '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
  const mb = b => b ? Math.round(b / 1048576) + ' MB' : '';
  const tel = p => String(p).replace(/[^+\d]/g, '');

  function detectOS() {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    return 'other';
  }

  // Apple Silicon vs Intel: Chromium exposes the CPU architecture, otherwise the GPU name gives it away.
  async function macArch() {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues(['architecture']);
        if (v.architecture) return v.architecture === 'arm' ? 'arm' : 'x64';
      }
    } catch (e) { /* ignore */ }
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Intel|AMD|Radeon|NVIDIA/i.test(r)) return 'x64';
    } catch (e) { /* ignore */ }
    return 'arm'; // every Mac sold since 2020
  }

  // Step texts are trusted markup; the app name is escaped before it goes in.
  function stepsFor(os, auto, app) {
    const smart = ' Waarschuwt Windows met een blauw scherm? Klik op <b>Meer info</b> en daarna op <b>Toch uitvoeren</b>.';
    let first;
    if (os === 'windows') {
      first = ['dl', 'Download en open', auto
        ? 'Klik op de downloadknop en open het bestand. Je hoeft niets te installeren.' + smart
        : 'Klik op de downloadknop, open het bestand en koppel de app eenmalig aan onze server (zie hieronder).' + smart];
    } else if (os === 'mac') {
      first = ['dl', 'Download en installeer', 'Open de .dmg en sleep ' + esc(app) + ' naar <b>Apps</b>. Geef bij de eerste start toestemming voor <b>Schermopname</b> en <b>Toegankelijkheid</b>.'];
    } else {
      first = ['laptop', 'Gebruik je computer', 'Het programma werkt op Windows en macOS. Open deze pagina op de computer waarop je hulp nodig hebt.'];
    }
    return [
      first,
      ['id', 'Geef je ID en wachtwoord door', 'Het programma toont <b>jouw eigen</b> ID en een eenmalig wachtwoord. Lees die voor via de telefoon of chat.'],
      ['shield', 'Accepteer en ontspan', 'Je ziet wanneer de supportmedewerker meekijkt. Je kunt de verbinding op elk moment zelf verbreken.'],
    ];
  }

  let copyTimer;
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      document.body.removeChild(t);
    }
    const label = $('#cfg-copy-label');
    label.textContent = 'Gekopieerd';
    btn.classList.add('done');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { label.textContent = 'Kopieer code'; btn.classList.remove('done'); }, 2200);
  }

  function downloadStarted() {
    const n = $('#cta-note');
    n.className = 'cta-note started';
    n.innerHTML = ic('check') + '<span><b>Download gestart.</b> Open het bestand zodra het klaar is. Je vindt het in je map Downloads.</span>';
  }

  function showError() {
    document.body.classList.add('is-error');
    $('#intro').textContent = '';
    $('#cta-note').textContent = '';
    $('#cta').innerHTML = '<div class="notice err" role="alert">' + ic('warn') +
      '<div><b>De downloads konden niet worden geladen</b><p>Controleer je internetverbinding en probeer het opnieuw.</p>' +
      '<button type="button" class="retry" id="retry">Opnieuw proberen</button></div></div>';
    $('#retry').onclick = () => location.reload();
  }

  fetch('/public-api/info').then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(async info => {
    const p = info.portal || {};
    const app = info.name || 'de app';
    const company = p.company || app;
    const title = p.title || 'Hulp op afstand';
    document.title = title + ' · ' + company;
    $('#company').textContent = company;
    document.querySelectorAll('.app-name').forEach(el => { el.textContent = app; });
    $('#foot-brand').textContent = '© ' + new Date().getFullYear() + ' ' + company;
    $('#title').textContent = title;
    $('#intro').textContent = p.intro ||
      'Download ' + app + ', open het programma en lees je ID en wachtwoord voor aan je supportmedewerker. Er wordt pas verbinding gemaakt als jij dat toestaat.';

    if (p.phone) {
      const tc = $('#top-call');
      tc.hidden = false;
      tc.href = 'tel:' + tel(p.phone);
      tc.setAttribute('aria-label', 'Bel ons: ' + p.phone);
      tc.innerHTML = ic('phone') + '<span>Bel ons</span><span class="num">' + esc(p.phone) + '</span>';
    }

    const os = detectOS();
    const plats = Array.isArray(info.platforms) ? info.platforms : [];
    const anyAvailable = plats.some(x => x.available);
    const byOs = plats.filter(x => x.os === os && x.available);
    let prefer = 'win_exe';
    if (os === 'mac') prefer = (await macArch()) === 'arm' ? 'mac_arm' : 'mac_x64';
    const primary = byOs.find(x => x.key === prefer) || byOs[0];
    const osName = { windows: 'Windows', mac: 'Mac' }[os];
    const altLabel = { mac_x64: 'Mac met Intel-processor?', mac_arm: 'Mac met Apple-chip?' };

    let cta = '', note = '';
    if (os === 'mobile') {
      const addr = location.host + (location.pathname.length > 1 ? location.pathname : '');
      cta = '<div class="notice">' + ic('laptop') + '<div><b>Open deze pagina op je computer</b>' +
        '<p>' + esc(app) + ' werkt op Windows en Mac. Ga op de computer waarop je hulp nodig hebt naar:</p>' +
        '<span class="addr">' + esc(addr) + '</span></div></div>';
    } else if (primary) {
      const sub = [app, mb(primary.size)].filter(Boolean).join(' · ');
      cta = '<a class="btn primary" data-dl href="' + esc(primary.url) + '"><span class="ico">' + ic('dl') + '</span>' +
        '<span class="t">Download voor ' + esc(osName) + '<small>' + esc(sub) + '</small></span></a>';
      byOs.filter(x => x !== primary).slice(0, 1).forEach(x => {
        cta += '<a class="alt" data-dl href="' + esc(x.url) + '">' + esc(altLabel[x.key] || x.label) + '</a>';
      });
      note = (os === 'windows' ? 'Geen installatie nodig. ' : '') + 'Andere computer? <a href="#downloads">Bekijk alle downloads</a>';
    } else if (anyAvailable) {
      cta = '<a class="btn primary" href="#downloads"><span class="ico">' + ic('dl') + '</span>' +
        '<span class="t">Kies je download<small>Beschikbaar voor Windows en Mac</small></span></a>';
    } else {
      cta = '<div class="notice">' + ic('info') + '<div><b>Nog geen downloads beschikbaar</b>' +
        '<p>Probeer het later opnieuw of neem contact op met ' + esc(company) + '.</p></div></div>';
    }
    $('#cta').innerHTML = cta;
    const noteEl = $('#cta-note');
    noteEl.className = 'cta-note';
    noteEl.innerHTML = note;

    const auto = !!(os === 'windows' && info.windows_auto_config && primary && primary.key === 'win_exe');
    $('#steps').innerHTML = stepsFor(os, auto, app).map(s =>
      '<li class="step"><span class="s-ic">' + ic(s[0]) + '</span><b class="h">' + esc(s[1]) + '</b><p>' + s[2] + '</p></li>').join('');

    // One-time server pairing: needed on Mac (and on Windows when the self-configuring download isn't available)
    const needCfg = !!(info.config_string && (os === 'mac' || (os === 'windows' && !auto)));
    $('#mac-sec').hidden = !needCfg;
    if (needCfg) {
      $('#mac-title').textContent = 'Koppel ' + app + ' aan onze server';
      $('#cfg').textContent = info.config_string;
      $('#cfg-copy').onclick = e => copyText(info.config_string, e.currentTarget);
    }

    $('#dl-grid').innerHTML = plats.length ? plats.map(x => {
      const rec = !!(primary && x.key === primary.key);
      const inner = '<span class="oi">' + ic(x.os === 'windows' ? 'win' : 'mac') + '</span>' +
        '<span class="m">' + (rec ? '<span class="rec-tag">Aanbevolen</span>' : '') + '<b>' + esc(x.label) + '</b>' +
        '<small>' + esc([x.arch, x.available ? mb(x.size) : 'binnenkort beschikbaar'].filter(Boolean).join(' · ')) + '</small></span>' +
        (x.available ? ic('dl') : '');
      return x.available
        ? '<a class="dl' + (rec ? ' rec' : '') + '" data-dl href="' + esc(x.url) + '">' + inner + '</a>'
        : '<div class="dl off" aria-disabled="true">' + inner + '</div>';
    }).join('') : '<p class="empty">Er zijn nog geen downloads beschikbaar.</p>';

    document.querySelectorAll('a[data-dl]').forEach(a => { a.onclick = downloadStarted; });

    if (p.email || p.phone) {
      $('#contact-sec').hidden = false;
      $('#contact').innerHTML = '<div><h2 id="contact-h">Kom je er niet uit?</h2><p>Neem contact op met ' + esc(company) + ', we helpen je graag.</p></div>' +
        '<div class="c-actions">' +
        (p.phone ? '<a class="c-btn" href="tel:' + esc(tel(p.phone)) + '">' + ic('phone') + esc(p.phone) + '</a>' : '') +
        (p.email ? '<a class="c-btn' + (p.phone ? ' ghost' : '') + '" href="mailto:' + esc(p.email) + '">' + ic('mail') + esc(p.email) + '</a>' : '') +
        '</div>';
    }
  }).catch(showError);
})();
