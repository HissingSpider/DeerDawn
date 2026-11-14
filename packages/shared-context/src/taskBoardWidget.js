'use strict';

const TASK_BOARD_WIDGET_URI = 'ui://deerdawn/task-board/v1.html';
const TASK_BOARD_WIDGET_MIME = 'text/html;profile=mcp-app';

function isTaskBoardUiEnabled(env = process.env) {
  return String(env.MCP_TASK_BOARD_UI_ENABLED || '').toLowerCase() === 'true';
}

function taskBoardToolMeta() {
  return {
    ui: { resourceUri: TASK_BOARD_WIDGET_URI },
    'openai/outputTemplate': TASK_BOARD_WIDGET_URI,
    'openai/toolInvocation/invoking': 'Loading task board…',
    'openai/toolInvocation/invoked': 'Task board ready',
    // The board is entirely self-contained — inline CSS and JS, no fonts, no
    // images, no network of its own; every mutation goes back out through
    // manage_tasks on the host. So both domain lists are empty, and an empty
    // list is the claim: this widget fetches nothing. Hosts that enforce a
    // widget CSP need it declared rather than inferred, and a widget with no
    // declared policy is a review finding even when it turns out to be inert.
    'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
    'openai/widgetDescription': 'Project task board with cards grouped by phase, from Backlog through Done.',
  };
}

function taskBoardResource() {
  return {
    uri: TASK_BOARD_WIDGET_URI,
    name: 'DeerDawn task board',
    description: 'Interactive project task board shown when manage_tasks is used.',
    mimeType: TASK_BOARD_WIDGET_MIME,
  };
}

function taskBoardWidgetHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;--bg:#ffffff;--panel:#f6f7f9;--card:#ffffff;--line:#d9dde4;--text:#14171c;--muted:#5b6472}
@media(prefers-color-scheme:dark){:root{--bg:#111318;--panel:#191c23;--card:#222630;--line:#303643;--text:#f5f7fb;--muted:#9aa3b2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{padding:14px}.top{display:flex;align-items:end;justify-content:space-between;gap:10px;margin-bottom:12px}.title{font-size:15px;font-weight:700}.sub{color:var(--muted);font-size:11px}.chips{display:flex;flex-wrap:wrap;gap:5px}.chip{border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted)}.chip b{color:var(--text)}.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.lane{min-width:0;border:1px solid var(--line);border-radius:11px;background:var(--panel);padding:9px}.head{display:flex;align-items:center;gap:6px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:700;color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%}.count{margin-left:auto}.card{border:1px solid var(--line);border-radius:8px;background:var(--card);padding:8px;margin-top:6px}.card.done .text{text-decoration:line-through;opacity:.7}.text{overflow-wrap:anywhere}.controls{display:flex;justify-content:space-between;margin-top:5px}.ask{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}.ask-q{color:var(--muted);margin-right:auto}.ask button{border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;padding:2px 8px}.ask button.danger{border-color:#c0392b;color:#c0392b}.ask button.danger:hover{background:#c0392b;color:#fff}.controls button,.add button{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:2px 5px}.controls button:hover,.add button:hover{color:var(--text)}.more{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:7px 2px}.add{display:flex;gap:5px;margin-top:7px}.add input{width:100%;min-width:0;border:1px dashed var(--line);border-radius:7px;background:transparent;color:var(--text);padding:6px}.empty{color:var(--muted);padding:8px 2px}@media(max-width:700px){.board{grid-template-columns:repeat(2,minmax(0,1fr))}.top{align-items:start;flex-direction:column}}@media(max-width:430px){.board{grid-template-columns:1fr}}
</style></head><body><main><div class="top"><div><div class="title" id="title">Task board</div><div class="sub">Your project board, kept in sync by DeerDawn.</div></div><div class="chips" id="chips"></div></div><div class="board" id="board"><div class="empty">Loading board…</div></div></main>
<script>
const phases=['backlog','blocked','in_progress','integration','testing','done'];
const colors={backlog:'#94a3b8',blocked:'#ef4444',in_progress:'#fbbf24',integration:'#38bdf8',testing:'#a78bfa',done:'#34d399'};
let snapshot=null,seq=0,pending=new Map(),expanded={},pendingRemove=null;
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
function request(method,params){if(window.openai&&typeof window.openai.callTool==='function'&&method==='tools/call')return window.openai.callTool(params.name,params.arguments);return new Promise((resolve,reject)=>{const id='dd-'+(++seq);pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
function dataOf(result){return result?.structuredContent||result?.detail?.structuredContent||result?.result?.structuredContent||null}
async function call(args){pendingRemove=null;const result=await request('tools/call',{name:'manage_tasks',arguments:args});const data=dataOf(result);if(data?.board)render(data);else await refresh(args.project_id)}
async function refresh(projectId){const result=await request('tools/call',{name:'manage_tasks',arguments:{action:'list',...(projectId?{project_id:projectId}:{})}});const data=dataOf(result);if(data?.board)render(data)}
function render(data){snapshot=data;document.getElementById('title').textContent='Task board — '+(data.project_name||'Project');const counts=data.counts_by_phase||Object.fromEntries((data.board||[]).map(c=>[c.phase,(c.cards||[]).length]));const total=data.total_cards??Object.values(counts).reduce((a,b)=>a+b,0);const open=data.open_cards??total-(counts.done||0);const chips=document.getElementById('chips');chips.replaceChildren();[['Open',open],['Blocked',counts.blocked||0],['Active',counts.in_progress||0],['Testing',counts.testing||0]].forEach(([label,value])=>{const c=el('span','chip');const b=el('b','',String(value));c.append(b,document.createTextNode(' '+label));chips.append(c)});const board=document.getElementById('board');board.replaceChildren();(data.board||[]).forEach((column,index)=>{const lane=el('section','lane');const head=el('div','head');const dot=el('span','dot');dot.style.background=colors[column.phase]||'#94a3b8';head.append(dot,document.createTextNode(column.label||column.phase),el('span','count',String((column.cards||[]).length)));lane.append(head);const cards=expanded[column.phase]?(column.cards||[]):(column.cards||[]).slice(0,2);if(!cards.length)lane.append(el('div','empty','—'));cards.forEach(card=>{const box=el('article','card'+(column.phase==='done'?' done':''));box.append(el('div','text',card.title));if(card.kind!=='step'){if(pendingRemove===card.id){const ask=el('div','ask');ask.append(el('span','ask-q','Remove this card?'));const yes=el('button','danger','Remove');const no=el('button','','Keep');yes.title='Remove permanently';no.title='Cancel';yes.onclick=()=>call({action:'remove',project_id:data.project_id,todos:[card.id],confirm_destructive:true});no.onclick=()=>{pendingRemove=null;render(snapshot)};ask.append(no,yes);box.append(ask)}else{const controls=el('div','controls');const prev=el('button','',index?'‹':'');const remove=el('button','','×');const next=el('button','',index<phases.length-1?'›':'');prev.disabled=!index;next.disabled=index===phases.length-1;prev.title='Move left';next.title='Move right';remove.title='Remove card';prev.onclick=()=>call({action:'move',project_id:data.project_id,todos:[card.id],phase:phases[index-1]});next.onclick=()=>call({action:'move',project_id:data.project_id,todos:[card.id],phase:phases[index+1]});remove.onclick=()=>{pendingRemove=card.id;render(snapshot)};controls.append(prev,remove,next);box.append(controls)}}lane.append(box)});const hidden=(column.cards||[]).length-cards.length;if(hidden>0){const more=el('button','more','+'+hidden+' more');more.onclick=()=>{expanded[column.phase]=true;render(snapshot)};lane.append(more)}else if(expanded[column.phase]&&(column.cards||[]).length>2){const less=el('button','more','Show less');less.onclick=()=>{expanded[column.phase]=false;render(snapshot)};lane.append(less)}const add=el('form','add');const input=el('input');input.placeholder='+ Add card';add.append(input);add.onsubmit=e=>{e.preventDefault();const title=input.value.trim();if(title)call({action:'add',project_id:data.project_id,todos:[title],phase:column.phase})};lane.append(add);board.append(lane)})}
addEventListener('message',event=>{const msg=event.data;if(msg?.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(msg.error):p.resolve(msg.result);return}if(msg?.method==='ui/notifications/tool-result'){const data=dataOf(msg.params);if(data?.board)render(data);else refresh(data?.project_id)}});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
const initial=dataOf(window.openai?.toolOutput)||window.openai?.toolOutput;if(initial?.board)render(initial);
</script></body></html>`;
}

module.exports = {
  TASK_BOARD_WIDGET_URI,
  TASK_BOARD_WIDGET_MIME,
  isTaskBoardUiEnabled,
  taskBoardToolMeta,
  taskBoardResource,
  taskBoardWidgetHtml,
};
