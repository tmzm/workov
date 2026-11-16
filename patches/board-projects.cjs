// Workerov: the Board page shows the tickets of every registered project, with a project selector next to the filter.
// Tickets of another project are merged into the board's own columns as cards with a project tag (their ids are shown as
// "<PRE>-001" so numbers never collide); a click on one opens that project's own dashboard on the ticket, where it is
// reviewed and answered. Local tickets keep working exactly as before. Needs /api/wv/projects (patch projects-board).
// Idempotent. Apply after projects-board.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (!h.includes('id="board-project"')) {
  const must = (cond, what) => { if (!cond) throw new Error('anchor missing: ' + what); };

  // 1. the selector, right before the text filter
  const sel = `<div class="filter" id="board-project-wrap" hidden>
                <label class="sr-only" for="board-project">Project</label>
                <select id="board-project" aria-label="Project"></select>
              </div>
              `;
  const f = /<div class="filter">\s*<svg class="i" aria-hidden="true"><use href="#i-filter" \/><\/svg>/.exec(h);
  must(f, 'board filter');
  h = h.slice(0, f.index) + sel + h.slice(f.index);

  // 2. merge foreign tickets into the board's cards
  const loop = `        (stateData.tickets || []).forEach((t, idx) => {
          const d = cardInfo(t, agentByNum);
          d.idx = idx;
          byStage[stageOfStatus(d.status)].push(d);
        });`;
  must(h.includes(loop), 'board card loop');
  h = h.replace(loop, `        const wvAll = window.wvBoardTickets ? window.wvBoardTickets(stateData.tickets || []) : stateData.tickets || [];
        wvAll.forEach((t, idx) => {
          const d = cardInfo(t, agentByNum);
          d.idx = idx;
          if (t.wvProject) { d.project = t.wvProject; d.projectRaw = t.wvRaw; }
          byStage[stageOfStatus(d.status)].push(d);
        });`);

  // 3. foreign cards: a project tag and a click that opens the other dashboard
  const tag = `        const meta = [];
        if (d.flag)`;
  must(h.includes(tag), 'card meta');
  h = h.replace(tag, `        const meta = [];
        if (d.project) meta.push(h('span', { class: 'plate quiet', title: 'Project', text: d.project }));
        if (d.flag)`);
  const click = `        card.addEventListener('click', () => openTicketDrawer(d.id));`;
  must(h.includes(click), 'card click');
  h = h.replace(click, `        card.addEventListener('click', () => {
          if (d.project) window.wvOpenForeign(d.project, d.projectRaw);
          else openTicketDrawer(d.id);
        });`);

  // 4. the data + selector script, last
  const script = `<script>
  (function () {
    var KEY = 'wv_board_project', foreign = [], names = [], selected = 'all';
    try { selected = localStorage.getItem(KEY) || 'all'; } catch (e) { /* storage blocked */ }
    function pre(name) { return String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'PRJ'; }
    window.wvBoardTickets = function (local) {
      var out = [];
      if (selected === 'all' || selected === window.__wvSelf) out = out.concat(local);
      foreign.forEach(function (t) { if (selected === 'all' || selected === t.wvProject) out.push(t); });
      return out;
    };
    var box = document.getElementById('board-project'), wrap = document.getElementById('board-project-wrap');
    function fill() {
      if (!box) return;
      var want = ['all'].concat(names);
      if (box.options.length !== want.length || want.some(function (n, i) { return box.options[i].value !== n; })) {
        box.textContent = '';
        want.forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = n === 'all' ? 'All projects' : n; box.append(o); });
      }
      if (want.indexOf(selected) < 0) selected = 'all';
      box.value = selected;
      if (wrap) wrap.hidden = names.length < 2;
    }
    function redraw() { if (typeof renderState === 'function') renderState(); }
    if (box) box.addEventListener('change', function () {
      selected = box.value;
      try { localStorage.setItem(KEY, selected); } catch (e) { /* storage blocked */ }
      redraw();
    });
    var last = '';
    function load() {
      var hd = {}; var tk = ''; try { tk = localStorage.getItem('worker_fleet_token') || ''; } catch (e) { /* none */ }
      if (tk) hd.Authorization = 'Bearer ' + tk;
      fetch('/api/wv/projects', { headers: hd }).then(function (r) { return r.json(); }).then(function (d) {
        var next = [];
        names = (d.projects || []).map(function (p) { return p.name; });
        (d.projects || []).forEach(function (p) {
          if (p.self) { window.__wvSelf = p.name; return; }
          p.tickets.forEach(function (t) {
            next.push({ id: pre(p.name) + '-' + t.id, title: t.title, status: t.status, mode: t.mode || 'solo', prio: 'P1', runs: 'alongside', deps: [], dependents: [], wvProject: p.name, wvRaw: t.id });
          });
        });
        var sig = JSON.stringify([names, next.map(function (t) { return [t.id, t.status, t.title]; })]);
        foreign = next; fill();
        if (sig !== last) { last = sig; redraw(); }
      }).catch(function () { /* the board still shows the local tickets */ });
    }
    window.wvOpenForeign = function (project, id) {
      var dlg = document.getElementById('wv-foreign-dlg');
      if (!dlg) {
        dlg = document.createElement('dialog'); dlg.id = 'wv-foreign-dlg';
        dlg.style.cssText = 'max-width:min(860px,94vw);width:100%;border:1px solid var(--line,#8886);border-radius:12px;padding:0;background:var(--bg,#fff);color:var(--text,inherit)';
        document.body.append(dlg);
        dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
      }
      dlg.textContent = '';
      var wrap = document.createElement('div'); wrap.style.cssText = 'padding:16px 18px';
      var head = document.createElement('div'); head.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px';
      var title = document.createElement('strong'); title.textContent = project + ' · ticket ' + id + ' …';
      var msg = document.createElement('div'); msg.className = 'note-s'; msg.setAttribute('role', 'status'); msg.style.margin = '6px 0';
      var pre = document.createElement('pre'); pre.style.cssText = 'white-space:pre-wrap;font-size:12.5px;max-height:60vh;overflow:auto;margin:8px 0 0'; pre.textContent = 'Loading…';
      var close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close'; close.addEventListener('click', function () { dlg.close(); });
      head.append(title); wrap.append(head, msg, pre); dlg.append(wrap);
      if (!dlg.open) dlg.showModal();
      var hd = {}; var tk = ''; try { tk = localStorage.getItem('worker_fleet_token') || ''; } catch (e) { /* none */ }
      if (tk) hd.Authorization = 'Bearer ' + tk;
      function act(op, label) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (op === 'dispatch' ? ' primary' : ''); b.textContent = label;
        b.addEventListener('click', function () {
          if (!confirm(label + ' ticket ' + id + ' of ' + project + '?')) return;
          var h2 = { 'Content-Type': 'application/json' }; if (tk) h2.Authorization = 'Bearer ' + tk;
          fetch('/api/action', { method: 'POST', headers: h2, body: JSON.stringify({ action: 'wv_project_action', project: project, ticket: id, op: op }) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (x) { msg.textContent = x.ok ? (x.j.note || 'Done.') : (x.j.error || 'Could not do that.'); load(); });
        });
        return b;
      }
      fetch('/api/wv/project-ticket?project=' + encodeURIComponent(project) + '&ticket=' + encodeURIComponent(id), { headers: hd })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          title.textContent = project + ' · ' + id + ' · ' + (d.title || '');
          var st = document.createElement('span'); st.className = 'badge'; st.textContent = d.status || ''; head.append(st);
          if (d.status === 'draft') head.append(act('dispatch', 'Dispatch'));
          else if (d.status === 'in-progress' || d.status === 'ready') head.append(act('pause', 'Pause'));
          head.append(close);
          pre.textContent = d.rd || d.error || 'No plan file yet.';
        }).catch(function () { pre.textContent = 'Could not read this ticket.'; head.append(close); });
    };
    fill(); load(); setInterval(load, 6000);
  })();
</script>
`;
  const i = h.lastIndexOf('</body>');
  must(i >= 0, '</body>');
  h = h.slice(0, i) + script + h.slice(i);
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
  console.log('board projects: page patched');
}

// ---- Needs you: count the drafts of every project, and make Review open one ----
{
  let h = fs.readFileSync(H, 'utf8');
  const crlf = h.includes('\r\n');
  h = h.replace(/\r\n/g, '\n');
  if (!h.includes('wvDraftCount')) {
    const must = (c, w) => { if (!c) throw new Error('anchor missing: ' + w); };
    const a = `        const drafts = tickets.filter(
          (t) => String(t.status || '').toLowerCase() === 'draft',
        ).length;`;
    must(h.includes(a), 'drafts count');
    h = h.replace(a, `        const drafts = window.wvDraftCount
          ? window.wvDraftCount(tickets)
          : tickets.filter((t) => String(t.status || '').toLowerCase() === 'draft').length;`);
    const b = `                  onclick: () => jumpToStage('plan'),
                },
                'Review',`;
    must(h.includes(b), 'drafts Review button');
    h = h.replace(b, `                  onclick: () => (window.wvReviewDrafts ? window.wvReviewDrafts() : jumpToStage('plan')),
                },
                'Review',`);
    const c = `    var box = document.getElementById('board-project'), wrap`;
    must(h.includes(c), 'board script');
    h = h.replace(c, `    function drafts(local) {
      var out = local.filter(function (t) { return String(t.status || '').toLowerCase() === 'draft'; }).map(function (t) { return { id: t.id, local: true }; });
      foreign.forEach(function (t) { if (t.status === 'draft') out.push({ id: t.id, project: t.wvProject, raw: t.wvRaw }); });
      return out;
    }
    window.wvDraftCount = function (local) { return drafts(local).length; };
    window.wvReviewDrafts = function () {
      var list = drafts((typeof stateData !== 'undefined' && stateData && stateData.tickets) || []);
      jumpToStage('plan');
      if (!list.length) return;
      var d = list[0];
      if (d.local) openTicketDrawer(d.id); else window.wvOpenForeign(d.project, d.raw);
    };
` + c);
    fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
    console.log('board projects: Needs you drafts patched');
  }
}
