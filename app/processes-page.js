'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let busy = false, timer = null;
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  async function stop(row, btn) {
    busy = true; btn.disabled = true;
    const r = await window.fleetProcesses.stop(row.pid, row.start);
    busy = false;
    if (r && r.cancelled) { btn.disabled = false; return; }
    if (r && !r.ok) { $('list').prepend(el('div', 'err', 'Could not stop it: ' + r.error)); }
    load();
  }
  function render(rows) {
    const list = $('list'); list.textContent = '';
    if (!rows.length) { list.append(el('div', 'empty', 'Nothing is running in the background.')); }
    let group = '';
    for (const r of rows) {
      if (r.group !== group) { group = r.group; list.append(el('h2', null, group)); }
      const row = el('div', 'row'), info = el('div');
      info.append(el('div', 'name', r.label), el('div', 'meta', 'started ' + ago(r.start) + ' ago · ' + r.processes + (r.processes === 1 ? ' process' : ' processes') + ' · pid ' + r.pid));
      const mem = el('div', r.memoryMB >= 500 ? 'mem high' : 'mem', r.memoryMB + ' MB');
      const btn = el('button', 'stop', 'Stop…'); btn.type = 'button'; btn.setAttribute('aria-label', 'Stop ' + r.label);
      btn.addEventListener('click', () => stop(r, btn));
      row.append(info, mem, btn); list.append(row);
    }
    const total = rows.reduce((a, r) => a + r.memoryMB, 0);
    $('total').textContent = total >= 1024 ? (total / 1024).toFixed(1) + ' GB' : total + ' MB';
    $('count').textContent = rows.length + (rows.length === 1 ? ' item' : ' items');
  }
  async function load() {
    if (busy) return;
    try { render(await window.fleetProcesses.list()); }
    catch (e) { $('list').textContent = ''; $('list').append(el('div', 'err', 'Could not read the process list: ' + (e && e.message || e))); }
  }
  $('refresh').addEventListener('click', load);
  load(); timer = setInterval(load, 5000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
