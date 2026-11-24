(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    windows: '<path d="M3 5.5 10.5 4.5v7H3zM12 4.3 21 3v8.5h-9zM3 12.5h7.5v7L3 18.5zM12 12.5h9V21l-9-1.3z"/>',
    mac: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    linux: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    android: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    dl: '<path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"/>',
  };
  const ic = (n, s) => '<svg width="' + (s || 20) + '" height="' + (s || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICON[n] || ICON.dl) + '</svg>';
  const mb = b => b ? (b / 1048576).toFixed(0) + ' MB' : '';

  function detectOS() {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua)) return 'other';
    return 'windows';
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

  function stepsFor(os, auto) {
    const s = [];
    if (os === 'windows') {
      s.push(['Download en start', auto ? 'Open het gedownloade bestand. Installeren is niet nodig, de app is direct klaar voor gebruik.' : 'Open het gedownloade bestand en voer daarna één keer de serverinstelling hieronder in.']);
    } else if (os === 'mac') {
      s.push(['Download en installeer', 'Open de .dmg, sleep de app naar de map Apps en sta bij de eerste start <i>Schermopname</i> en <i>Toegankelijkheid</i> toe. Voer daarna de serverinstelling hieronder in.']);
    } else {
      s.push(['Gebruik een computer', 'De app is beschikbaar voor Windows en macOS. Open deze pagina op de computer waarop je hulp nodig hebt.']);
    }
    s.push(['Geef je ID en wachtwoord door', 'De app toont een ID en een eenmalig wachtwoord. Geef deze telefonisch of per chat door aan je supportmedewerker.']);
    s.push(['Accepteer de verbinding', 'Je ziet een melding zodra de supportmedewerker verbindt. Je kunt de sessie altijd zelf beëindigen.']);
    return s;
  }

  fetch('/public-api/info').then(r => r.json()).then(async info => {
    const p = info.portal || {};
    document.title = (p.title || 'Hulp op afstand') + ' · ' + (p.company || info.name);
    $('#company').textContent = p.company || info.name;
    $('#foot-brand').textContent = '© ' + new Date().getFullYear() + ' ' + (p.company || info.name);
    $('#title').textContent = p.title || 'Hulp op afstand';
    $('#intro').textContent = p.intro || '';

    const os = detectOS();
    const plats = info.platforms || [];
    const byOs = plats.filter(x => x.os === os && x.available);
    let prefer = 'win_exe';
    if (os === 'mac') prefer = (await macArch()) === 'arm' ? 'mac_arm' : 'mac_x64';
    const primary = byOs.find(x => x.key === prefer) || byOs[0];
    const osName = { windows: 'Windows', mac: 'macOS' }[os] || 'dit apparaat';
    const altLabel = { mac_x64: 'Mac met Intel-processor?', mac_arm: 'Mac met Apple-chip?', win_msi: 'MSI-installer' };

    let cta = '';
    if (primary) {
      cta += `<a class="btn primary" href="${esc(primary.url)}"><span class="ico">${ic('dl', 18)}</span><span class="t">Download ${esc(info.name)} voor ${esc(osName)}<small>${esc(primary.arch)} · ${mb(primary.size)}</small></span></a>`;
      byOs.filter(x => x !== primary).slice(0, 1).forEach(x => {
        cta += `<a class="btn secondary" href="${esc(x.url)}"><span class="t">${esc(altLabel[x.key] || x.label)}<small>${esc(x.arch)}</small></span></a>`;
      });
    } else {
      cta = `<a class="btn primary" href="#downloads"><span class="ico">${ic('dl', 18)}</span><span class="t">Kies je download<small>Beschikbaar voor Windows en macOS</small></span></a>`;
    }
    $('#cta').innerHTML = cta;

    const auto = os === 'windows' && info.windows_auto_config && primary && primary.key === 'win_exe';
    $('#steps').innerHTML = stepsFor(os, auto).map(s => `<li><b>${esc(s[0])}</b><p>${s[1]}</p></li>`).join('');

    $('#config-sec').hidden = !(info.config_string && !auto);
    if (info.config_string && !auto) {
      $('#config-sec').hidden = false;
      $('#cfg').textContent = info.config_string;
      $('#cfg-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(info.config_string); }
        catch (e) {
          const t = document.createElement('textarea'); t.value = info.config_string; document.body.appendChild(t); t.select();
          document.execCommand('copy'); t.remove();
        }
        $('#cfg-copy').textContent = 'Gekopieerd ✓';
        setTimeout(() => { $('#cfg-copy').textContent = 'Kopiëren'; }, 2000);
      };
    }

    const osIcon = { windows: 'windows', mac: 'mac' };
    $('#dl-grid').innerHTML = plats.length ? plats.map(x => `
      <a class="dl ${x.available ? '' : 'off'}" href="${x.available ? esc(x.url) : '#'}">
        <span class="oi">${ic(osIcon[x.os])}</span>
        <span><b>${esc(x.label)}</b><small>${esc(x.arch)}${x.available ? ' · ' + mb(x.size) + (x.version ? ' · v' + esc(x.version) : '') : ' · binnenkort beschikbaar'}</small></span>
        <span class="arrow">${ic('dl', 18)}</span>
      </a>`).join('') : '<p class="muted">Er zijn nog geen downloads beschikbaar.</p>';

    if (p.email || p.phone) {
      $('#contact-sec').hidden = false;
      $('#contact').innerHTML = `<div><h3>Hulp nodig?</h3><span class="muted">Neem contact op met ${esc(p.company || info.name)}</span></div>` +
        (p.phone ? `<a href="tel:${esc(p.phone.replace(/[^+\d]/g, ''))}">📞 ${esc(p.phone)}</a>` : '') +
        (p.email ? `<a href="mailto:${esc(p.email)}">✉️ ${esc(p.email)}</a>` : '');
    }
  }).catch(() => {
    $('#intro').textContent = 'De downloadpagina kon niet worden geladen. Probeer het later opnieuw.';
  });
})();
