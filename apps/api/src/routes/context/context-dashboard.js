const express = require('express');
const router = express.Router();

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deerdawn</title>
<style>
  :root {
    --bg:#080808; --bg1:#0f0f0f; --bg2:#141414; --bg3:#1c1c1c;
    --border:#1e1e1e; --border2:#2a2a2a;
    --text:#e2e2e2; --text2:#888; --text3:#3d3d3d;
    --green:#4ade80; --gdim:rgba(74,222,128,.1);
    --red:#f87171;
    --mono:'SF Mono','Fira Code','Cascadia Code',ui-monospace,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:13px;line-height:1.6;min-height:100vh;padding-bottom:48px}
  .wrap{max-width:1080px;margin:0 auto;padding:0 28px}
  header{display:flex;align-items:center;justify-content:space-between;padding:22px 0 20px;border-bottom:1px solid var(--border);margin-bottom:32px}
  .logo{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:13px;color:var(--text)}
  .pulse{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px rgba(74,222,128,.5);animation:glow 2.5s ease-in-out infinite}
  @keyframes glow{0%,100%{box-shadow:0 0 10px rgba(74,222,128,.5)}50%{box-shadow:0 0 3px rgba(74,222,128,.2)}}
  .hright{display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:11px;color:var(--text3)}
  .spinner{width:13px;height:13px;border:1.5px solid var(--border2);border-top-color:var(--green);border-radius:50%;opacity:0;transition:opacity .2s}
  .spinner.on{opacity:1;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  section{margin-bottom:36px}
  .slabel{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);margin-bottom:14px;display:flex;align-items:center;gap:10px}
  .slabel::after{content:'';flex:1;height:1px;background:var(--border)}
  .gcard{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:20px 36px}
  @media(max-width:680px){.gcard{grid-template-columns:1fr}}
  .field{display:flex;flex-direction:column;gap:6px}
  .field.wide{grid-column:1/-1}
  .flabel{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text3)}
  textarea.fval{background:var(--bg2);border:1px solid var(--border2);border-radius:5px;color:var(--text);font-family:var(--sans);font-size:13px;line-height:1.5;padding:8px 10px;resize:none;outline:none;width:100%;transition:border-color .15s}
  textarea.fval:focus{border-color:var(--green)}
  textarea.fval::placeholder{color:var(--text3)}
  .tagwrap{background:var(--bg2);border:1px solid var(--border2);border-radius:5px;padding:6px 8px;min-height:38px;display:flex;flex-wrap:wrap;gap:5px;align-items:center;cursor:text;transition:border-color .15s}
  .tagwrap:focus-within{border-color:var(--green)}
  .tag{display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:2px 8px;font-family:var(--mono);font-size:11px;color:var(--text2)}
  .tagx{cursor:pointer;color:var(--text3);font-size:13px;transition:color .1s}
  .tagx:hover{color:var(--red)}
  .tagin{border:none;outline:none;background:transparent;color:var(--text);font-family:var(--mono);font-size:11px;flex:1;min-width:70px}
  .tagin::placeholder{color:var(--text3)}
  .saverow{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-end;gap:12px}
  .savedmsg{font-family:var(--mono);font-size:11px;color:var(--green);opacity:0;transition:opacity .3s}
  .savedmsg.on{opacity:1}
  .btn{font-family:var(--mono);font-size:11px;padding:7px 18px;border-radius:5px;cursor:pointer;transition:all .15s;border:1px solid var(--border2);background:var(--bg2);color:var(--text2);letter-spacing:.04em}
  .btn:hover{color:var(--text);border-color:#3a3a3a}
  .btn.pri{background:var(--gdim);border-color:var(--green);color:var(--green)}
  .btn.pri:hover{background:rgba(74,222,128,.18)}
  .btn.pri:active{transform:scale(.97)}
  .pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
  .pcard{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;transition:border-color .2s}
  .pcard:hover{border-color:var(--border2)}
  .pname{font-family:var(--mono);font-size:13px;font-weight:500;letter-spacing:-.2px}
  .prows{display:flex;flex-direction:column;gap:5px}
  .prow{display:flex;gap:10px;align-items:baseline}
  .pkey{font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;min-width:50px;flex-shrink:0}
  .pval{font-size:12px;color:var(--text2);line-height:1.4}
  .chips{display:flex;flex-wrap:wrap;gap:4px}
  .chip{font-family:var(--mono);font-size:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:2px 6px;color:var(--text3)}
  .chip.g{color:var(--green);background:var(--gdim);border-color:rgba(74,222,128,.25)}
  .dec{font-size:11px;color:var(--text3);padding-left:9px;border-left:2px solid var(--border2);line-height:1.4}
  .empty{font-family:var(--mono);font-size:12px;color:var(--text3);text-align:center;padding:40px 0}
  .bar{position:fixed;bottom:0;left:0;right:0;height:36px;background:var(--bg1);border-top:1px solid var(--border);display:flex;align-items:center;padding:0 28px;gap:20px;font-family:var(--mono);font-size:11px;color:var(--text3);z-index:50}
  .bdot{width:5px;height:5px;border-radius:50%;background:var(--green);display:inline-block;margin-right:5px}
  .skel{background:var(--bg2);border-radius:4px;animation:shim 1.3s ease-in-out infinite}
  @keyframes shim{0%,100%{opacity:1}50%{opacity:.45}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo"><span class="pulse"></span>deerdawn</div>
    <div class="hright"><span class="spinner" id="spin"></span><span id="rl">–</span></div>
  </header>
  <section>
    <div class="slabel">You</div>
    <div class="gcard" id="gc">
      <div class="skel wide" style="height:190px;grid-column:1/-1"></div>
    </div>
  </section>
  <section>
    <div class="slabel">Projects</div>
    <div class="pgrid" id="pg">
      <div class="pcard"><div class="skel" style="height:130px"></div></div>
      <div class="pcard"><div class="skel" style="height:130px"></div></div>
    </div>
  </section>
</div>
<div class="bar">
  <div><span class="bdot"></span>api :8080</div>
  <div id="bsync">last refresh –</div>
  <div id="bproj"></div>
</div>
<script>
const K = 'dev-key';
function q(el) { return document.getElementById(el); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

async function api(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: { 'X-Api-Key': K, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

function tagInput(vals, ph) {
  const items = [...(vals || [])];
  const wrap = el('div', 'tagwrap');
  const inp = el('input', 'tagin'); inp.placeholder = ph;

  function draw() {
    clear(wrap);
    items.forEach((v, i) => {
      const t = el('span', 'tag', v);
      const x = el('span', 'tagx', '×');
      x.onclick = () => { items.splice(i, 1); draw(); };
      t.appendChild(x); wrap.appendChild(t);
    });
    wrap.appendChild(inp);
  }
  inp.onkeydown = e => {
    if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) {
      e.preventDefault(); items.push(inp.value.trim()); inp.value = ''; draw();
    }
    if (e.key === 'Backspace' && !inp.value && items.length) { items.pop(); draw(); }
  };
  wrap.onclick = () => inp.focus();
  draw();
  return { el: wrap, get: () => items };
}

function mkField(cls, label, child) {
  const d = el('div', 'field ' + cls);
  d.appendChild(el('div', 'flabel', label));
  d.appendChild(child);
  return d;
}

let refs = {};
function renderGlobal(g) {
  g = g || {};
  const gc = q('gc'); clear(gc);
  const ta = el('textarea', 'fval'); ta.rows = 2;
  ta.placeholder = 'Who you are, your role, your background…';
  ta.value = g.user_profile || '';

  refs = {
    prefs: tagInput(g.preferences, 'add preference + enter'),
    instrs: tagInput(g.recurring_instructions, 'add instruction + enter'),
    stack: tagInput(g.global_stack, 'add technology + enter'),
  };

  gc.appendChild(mkField('wide', 'About me', ta));
  gc.appendChild(mkField('', 'Preferences', refs.prefs.el));
  gc.appendChild(mkField('', 'Always do', refs.instrs.el));
  gc.appendChild(mkField('wide', 'Default stack', refs.stack.el));

  const msg = el('span', 'savedmsg', 'saved ✓');
  const btn = el('button', 'btn pri', 'Save');
  btn.onclick = async () => {
    btn.textContent = '…'; btn.disabled = true;
    await api('/api/v1/context/global', 'PATCH', {
      user_profile: ta.value,
      preferences: refs.prefs.get(),
      recurring_instructions: refs.instrs.get(),
      global_stack: refs.stack.get()
    });
    btn.textContent = 'Save'; btn.disabled = false;
    msg.classList.add('on');
    setTimeout(() => msg.classList.remove('on'), 2200);
  };

  const row = el('div', 'saverow'); row.appendChild(msg); row.appendChild(btn);
  gc.appendChild(row);
}

function ago(d) {
  const s = Math.floor((Date.now() - new Date(d)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function renderProjects(projects) {
  projects = projects || [];
  const pg = q('pg'); clear(pg);
  q('bproj').textContent = projects.length + ' project' + (projects.length === 1 ? '' : 's');

  if (!projects.length) {
    const e = el('div', 'empty', 'No projects yet — start a conversation in Claude or ChatGPT.');
    pg.appendChild(e); return;
  }

  projects.forEach(p => {
    const c = p.context || {};
    const card = el('div', 'pcard');
    card.appendChild(el('div', 'pname', c.project_name || p.project_name || 'Untitled'));

    const rows = el('div', 'prows');

    function addRow(key, val) {
      if (!val) return;
      const r = el('div', 'prow');
      r.appendChild(el('span', 'pkey', key));
      r.appendChild(el('span', 'pval', val));
      rows.appendChild(r);
    }

    addRow('Status', c.current_status);
    addRow('Task', c.current_task);

    if ((c.tech_stack || []).length) {
      const r = el('div', 'prow');
      r.appendChild(el('span', 'pkey', 'Stack'));
      const chips = el('div', 'chips');
      c.tech_stack.slice(0, 5).forEach(s => chips.appendChild(el('span', 'chip', s)));
      r.appendChild(chips); rows.appendChild(r);
    }

    if ((c.recent_decisions || []).length) {
      const r = el('div', 'prow');
      r.appendChild(el('span', 'pkey', 'Decided'));
      const decs = el('div'); decs.style.cssText = 'display:flex;flex-direction:column;gap:4px';
      c.recent_decisions.slice(0, 2).forEach(d => decs.appendChild(el('div', 'dec', d.summary)));
      r.appendChild(decs); rows.appendChild(r);
    }

    card.appendChild(rows);

    if (p.updated_at) {
      const chips = el('div', 'chips');
      chips.appendChild(el('span', 'chip g', 'synced ' + ago(p.updated_at)));
      card.appendChild(chips);
    }

    pg.appendChild(card);
  });
}

let lastAt = null;
async function refresh(loud) {
  if (loud) q('spin').classList.add('on');
  try {
    const [g, ps] = await Promise.all([
      api('/api/v1/context/global'),
      api('/api/v1/context/projects')
    ]);
    renderGlobal(g.global);
    renderProjects(ps.projects);
    lastAt = new Date();
    q('bsync').textContent = 'last refresh ' + ago(lastAt);
  } catch (e) { console.warn(e); }
  finally { if (loud) q('spin').classList.remove('on'); }
}

let cd = 10;
setInterval(() => {
  cd--;
  if (cd <= 0) { cd = 10; refresh(true); }
  q('rl').textContent = cd === 10 ? 'auto' : 'refresh in ' + cd + 's';
}, 1000);

refresh(true);
</script>
</body>
</html>`;

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', 'default-src \'self\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'self\'; font-src \'self\' data:; img-src \'self\' data:');
  res.send(HTML);
});

module.exports = router;
