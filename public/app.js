// Multi-session client. Each session has its own log + in-progress assistant bubble;
// only the active session is shown, but streams continue in the background for others.

// Configure marked + highlight.js. marked@14 uses an options-object for highlight.
if (window.marked && window.hljs) {
  marked.setOptions({
    gfm: true,
    breaks: true,
  });
  marked.use({
    renderer: {
      code(token) {
        const lang = (token.lang || '').match(/^\S+/)?.[0] ?? '';
        let html;
        try {
          html = lang && hljs.getLanguage(lang)
            ? hljs.highlight(token.text, { language: lang, ignoreIllegals: true }).value
            : hljs.highlightAuto(token.text).value;
        } catch {
          html = escapeHtml(token.text);
        }
        return `<pre><code class="hljs language-${escapeHtml(lang)}">${html}</code></pre>`;
      },
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderMarkdown(text) {
  if (!window.marked) return escapeHtml(text);
  try { return marked.parse(text); }
  catch { return escapeHtml(text); }
}
const logEl = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = form.querySelector('button[type="submit"]');
const statusEl = document.getElementById('status');
const sessionListEl = document.getElementById('session-list');
const sessionTitleEl = document.getElementById('session-title');
const newSessionBtn = document.getElementById('new-session-btn');
const stopBtn = document.getElementById('stop-btn');
const attachmentsEl = document.getElementById('attachments');

// Pending image attachments for the next send. Each: { id, dataUrl, mediaType }
const pendingAttachments = [];

let ws;
let sessions = [];        // server-provided list, ordered by updated_at desc
let activeSessionId = null;
let toolsCollapsed = false;

// Per-session UI state kept in memory so we can swap views fast.
// { logHtml: string, streaming: bool, openAssistantId: string|null }
const sessionState = new Map();

function getState(id) {
  if (!sessionState.has(id)) {
    sessionState.set(id, { messages: [], streaming: false, openAssistant: null });
  }
  return sessionState.get(id);
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

function renderSessionList() {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');
    if (getState(s.id).streaming) li.classList.add('streaming');
    li.dataset.id = s.id;
    const dot = document.createElement('span'); dot.className = 'dot';
    const title = document.createElement('span'); title.className = 'title'; title.textContent = s.title;
    const menuBtn = document.createElement('button');
    menuBtn.className = 'menu-btn'; menuBtn.textContent = '⋯'; menuBtn.title = 'Session options';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionMenu(s, menuBtn);
    });
    li.appendChild(dot); li.appendChild(title); li.appendChild(menuBtn);
    li.addEventListener('click', () => selectSession(s.id));
    sessionListEl.appendChild(li);
  }
}

let openMenu = null;
function closeOpenMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('click', closeOpenMenu);

function openSessionMenu(session, anchor) {
  closeOpenMenu();
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeOpenMenu();
    const next = prompt('Rename session:', session.title);
    if (!next || next.trim() === session.title) return;
    await fetch(`/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next.trim() }),
    });
  });
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete'; deleteBtn.className = 'danger';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeOpenMenu();
    if (!confirm(`Delete "${session.title}"? This removes all messages.`)) return;
    await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
    if (activeSessionId === session.id) {
      activeSessionId = null;
      sessionState.delete(session.id);
      sessionTitleEl.textContent = '…';
      logEl.innerHTML = '';
    }
  });
  menu.append(renameBtn, deleteBtn);
  document.body.appendChild(menu);
  openMenu = menu;
}

function renderLog() {
  logEl.innerHTML = '';
  if (activeSessionId == null) return;
  const state = getState(activeSessionId);
  for (const m of state.messages) {
    appendBubble(m.role, m.text, m.streaming, m.id);
    const toolCalls = m.tool_calls ?? [];
    if (toolCalls.length) {
      const group = startToolGroup();
      for (const tc of toolCalls) appendToolBubble(tc, group);
      finalizeToolGroup(group);
    }
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// A "tool group" wraps consecutive tool calls into one collapsible <details>
// so a long batch doesn't dominate the view. We grab the group via the last
// child of logEl while it's still the open group.
function startToolGroup() {
  const wrap = document.createElement('div');
  wrap.className = 'msg tool-group';
  const details = document.createElement('details');
  details.open = !toolsCollapsed;
  const summary = document.createElement('summary');
  summary.className = 'tool-group-summary';
  const label = document.createElement('span');
  label.className = 'tool-group-label';
  const names = document.createElement('span');
  names.className = 'tool-group-names';
  summary.append(label, names);
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'tool-group-body';
  details.appendChild(body);
  wrap.appendChild(details);
  logEl.appendChild(wrap);
  updateToolGroupSummary(wrap);
  return wrap;
}

function getOrStartToolGroup() {
  const last = logEl.lastElementChild;
  if (last && last.classList.contains('tool-group') && !last.dataset.closed) {
    return last;
  }
  return startToolGroup();
}

function finalizeToolGroup(group) {
  if (group) group.dataset.closed = '1';
}

function updateToolGroupSummary(group) {
  const body = group.querySelector('.tool-group-body');
  const tools = [...body.querySelectorAll(':scope > .msg.tool')];
  const label = group.querySelector('.tool-group-label');
  const names = group.querySelector('.tool-group-names');
  const count = tools.length;
  label.textContent = count === 1 ? '1 tool call' : `${count} tool calls`;
  const uniq = [];
  for (const t of tools) {
    const n = t.querySelector('.tool-name')?.textContent;
    if (n && !uniq.includes(n)) uniq.push(n);
    if (uniq.length >= 4) break;
  }
  names.textContent = uniq.length ? ' · ' + uniq.join(', ') + (tools.length > uniq.length ? '…' : '') : '';
}

function appendBubble(role, text, streaming = false, id = null) {
  const el = document.createElement('div');
  el.className = `msg ${role}` + (streaming ? ' streaming' : '');
  if (id) el.dataset.msgId = id;
  const tag = document.createElement('div');
  tag.className = 'role'; tag.textContent = role;
  const body = document.createElement('div');
  body.className = 'body';
  setBubbleBody(body, role, text);
  el.appendChild(tag); el.appendChild(body);
  logEl.appendChild(el);
  return el;
}

function setBubbleBody(bodyEl, role, text) {
  if (role === 'assistant') {
    bodyEl.innerHTML = renderMarkdown(text || '');
  } else {
    bodyEl.textContent = text || '';
  }
}

function appendToolBubble(tc, group) {
  const target = group ?? getOrStartToolGroup();
  const groupBody = target.querySelector('.tool-group-body');
  const el = document.createElement('div');
  el.className = 'msg tool';
  el.dataset.toolId = tc.id;
  const details = document.createElement('details');
  // open while pending, collapse once we have a result — unless the user toggled "collapse all"
  details.open = toolsCollapsed ? false : !tc.result;
  const summary = document.createElement('summary');
  const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = tc.name;
  const argHint = document.createElement('span');
  argHint.textContent = ' ' + summarizeInput(tc.input);
  const status = document.createElement('span'); status.className = 'tool-status';
  status.textContent = tc.result ? (tc.result.isError ? 'error' : 'done') : 'running…';
  if (tc.result?.isError) status.classList.add('error');
  summary.append(name, argHint, status);
  details.appendChild(summary);
  const body = document.createElement('div'); body.className = 'tool-body';
  body.appendChild(makeSection('input', JSON.stringify(tc.input, null, 2)));
  if (tc.result) appendResultSections(body, tc.result);
  details.appendChild(body);
  el.appendChild(details);
  groupBody.appendChild(el);
  updateToolGroupSummary(target);
  return el;
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return `\`${truncate(input.command, 60)}\``;
  if (typeof input.file_path === 'string') return truncate(input.file_path, 60);
  if (typeof input.pattern === 'string') return `/${truncate(input.pattern, 60)}/`;
  const keys = Object.keys(input);
  return keys.length ? `{${keys.slice(0, 3).join(', ')}}` : '';
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function makeSection(label, text) {
  const wrap = document.createElement('div');
  const lab = document.createElement('div'); lab.className = 'tool-label'; lab.textContent = label;
  const pre = document.createElement('pre'); pre.textContent = text;
  wrap.append(lab, pre);
  return wrap;
}

function appendResultSections(body, result) {
  if (typeof result.stdout === 'string' && result.stdout) {
    body.appendChild(makeSection('stdout', result.stdout));
  }
  if (typeof result.stderr === 'string' && result.stderr) {
    body.appendChild(makeSection('stderr', result.stderr));
  }
  // Fall back to combined output if stdout/stderr weren't provided.
  if (result.output && (!result.stdout && !result.stderr)) {
    body.appendChild(makeSection(result.isError ? 'error' : 'output', result.output));
  }
}

function updateToolBubble(tc) {
  const el = logEl.querySelector(`[data-tool-id="${cssEscape(tc.id)}"]`);
  if (!el) return;
  const status = el.querySelector('.tool-status');
  if (status) {
    status.textContent = tc.result ? (tc.result.isError ? 'error' : 'done') : 'running…';
    status.classList.toggle('error', !!tc.result?.isError);
  }
  const body = el.querySelector('.tool-body');
  if (body && tc.result) {
    // Remove any prior result sections (keep only the leading input section).
    while (body.children.length > 1) body.removeChild(body.lastChild);
    appendResultSections(body, tc.result);
    el.querySelector('details').open = false;
  }
}

function cssEscape(s) { return (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&')); }

function selectSession(id) {
  activeSessionId = id;
  const s = sessions.find((x) => x.id === id);
  sessionTitleEl.textContent = s ? s.title : '…';
  renderSessionList();
  renderLog();
  updateStopButton();
  // Ask the server for fresh history (covers reconnect cases).
  ws?.send?.(JSON.stringify({ type: 'load_session', sessionId: id }));
}

function updateStopButton() {
  const streaming = activeSessionId != null && getState(activeSessionId).streaming;
  stopBtn.hidden = !streaming;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => { setStatus('connected', 'connected'); sendBtn.disabled = false; });
  ws.addEventListener('close', () => {
    setStatus('disconnected — retrying…', 'disconnected');
    sendBtn.disabled = true;
    setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => setStatus('error', 'disconnected'));
  ws.addEventListener('message', (e) => {
    let evt; try { evt = JSON.parse(e.data); } catch { return; }
    handleEvent(evt);
  });
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'session_list': {
      sessions = evt.sessions;
      if (activeSessionId == null && sessions.length) {
        selectSession(sessions[0].id);
      } else {
        renderSessionList();
      }
      break;
    }
    case 'session_created': {
      // Server also broadcasts session_list right before this; just select it.
      selectSession(evt.session.id);
      break;
    }
    case 'history': {
      const state = getState(evt.sessionId);
      state.messages = (evt.messages || []).map((m) => ({
        id: `db-${m.id}`,
        role: m.role,
        text: m.content?.text ?? '',
        tool_calls: m.content?.tool_calls ?? [],
        streaming: false,
      }));
      state.openAssistant = null;
      if (evt.sessionId === activeSessionId) renderLog();
      break;
    }
    case 'token': {
      const state = getState(evt.sessionId);
      let bubble = state.openAssistant;
      if (!bubble) {
        bubble = { id: `live-${Date.now()}`, role: 'assistant', text: '', tool_calls: [], streaming: true };
        state.messages.push(bubble);
        state.openAssistant = bubble;
        if (evt.sessionId === activeSessionId) appendBubble('assistant', '', true, bubble.id);
      }
      bubble.text += evt.text;
      if (evt.sessionId === activeSessionId) {
        const el = logEl.querySelector(`[data-msg-id="${bubble.id}"] .body`);
        if (el) setBubbleBody(el, 'assistant', bubble.text);
        logEl.scrollTop = logEl.scrollHeight;
      }
      break;
    }
    case 'tool_start': {
      const state = getState(evt.sessionId);
      const tc = { id: evt.toolUseId, name: evt.name, input: evt.input, result: null };
      if (state.openAssistant) state.openAssistant.tool_calls.push(tc);
      if (evt.sessionId === activeSessionId) {
        appendToolBubble(tc);
        logEl.scrollTop = logEl.scrollHeight;
      }
      break;
    }
    case 'tool_result': {
      const state = getState(evt.sessionId);
      const tc = state.openAssistant?.tool_calls.find((t) => t.id === evt.toolUseId);
      if (tc) {
        tc.result = {
          output: evt.output, isError: evt.isError,
          stdout: evt.stdout, stderr: evt.stderr, isImage: evt.isImage,
        };
      }
      if (evt.sessionId === activeSessionId) {
        updateToolBubble({ id: evt.toolUseId, result: {
          output: evt.output, isError: evt.isError,
          stdout: evt.stdout, stderr: evt.stderr, isImage: evt.isImage,
        }});
        logEl.scrollTop = logEl.scrollHeight;
      }
      break;
    }
    case 'state': {
      const state = getState(evt.sessionId);
      const prev = state.streaming;
      state.streaming = !(evt.state === 'complete' || evt.state === 'error');
      if (evt.state === 'complete' || evt.state === 'error') {
        if (state.openAssistant) {
          state.openAssistant.streaming = false;
          if (evt.sessionId === activeSessionId) {
            const el = logEl.querySelector(`[data-msg-id="${state.openAssistant.id}"]`);
            el?.classList.remove('streaming');
          }
          state.openAssistant = null;
        }
        if (evt.sessionId === activeSessionId) sendBtn.disabled = false;
      } else if (evt.state === 'requesting') {
        state.streaming = true;
      }
      if (prev !== state.streaming) renderSessionList();
      if (evt.sessionId === activeSessionId) updateStopButton();
      if (evt.state === 'error' && evt.sessionId === activeSessionId) {
        appendBubble('system', `error: ${evt.error || 'unknown'}`);
      }
      break;
    }
    case 'session': {
      // claude_id captured/updated. Nothing visible to do.
      break;
    }
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const hasImages = pendingAttachments.length > 0;
  if ((!text && !hasImages) || ws?.readyState !== WebSocket.OPEN || activeSessionId == null) return;

  const state = getState(activeSessionId);
  const displayText = (hasImages ? `[${pendingAttachments.length} image${pendingAttachments.length > 1 ? 's' : ''}]\n` : '') + text;
  const userMsg = { id: `live-u-${Date.now()}`, role: 'user', text: displayText, tool_calls: [], streaming: false };
  state.messages.push(userMsg);
  appendBubble('user', displayText);
  logEl.scrollTop = logEl.scrollHeight;

  const images = pendingAttachments.map((a) => ({ data: a.dataUrl, mediaType: a.mediaType }));
  ws.send(JSON.stringify({ type: 'send_message', sessionId: activeSessionId, text, images }));
  input.value = '';
  pendingAttachments.length = 0;
  renderAttachments();
  sendBtn.disabled = true;
});

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  attachmentsEl.hidden = pendingAttachments.length === 0;
  for (const att of pendingAttachments) {
    const chip = document.createElement('div'); chip.className = 'attachment';
    const img = document.createElement('img'); img.src = att.dataUrl; img.alt = att.mediaType;
    const rm = document.createElement('button'); rm.textContent = '×'; rm.title = 'Remove';
    rm.addEventListener('click', (e) => {
      e.preventDefault();
      const i = pendingAttachments.indexOf(att);
      if (i !== -1) pendingAttachments.splice(i, 1);
      renderAttachments();
    });
    chip.append(img, rm);
    attachmentsEl.appendChild(chip);
  }
}

input.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items ?? []);
  const images = items.filter((it) => it.type?.startsWith('image/'));
  if (images.length === 0) return;
  e.preventDefault();
  for (const it of images) {
    const file = it.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = () => {
      pendingAttachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        dataUrl: reader.result,
        mediaType: file.type || 'image/png',
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
});

input.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    form.requestSubmit();
  }
});

stopBtn.addEventListener('click', () => {
  if (activeSessionId == null) return;
  ws?.send?.(JSON.stringify({ type: 'cancel', sessionId: activeSessionId }));
});


newSessionBtn.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'new_session' }));
});

// ---------- Import-from-Claude-Code modal ----------
const importBtn = document.getElementById('import-btn');
const importModal = document.getElementById('import-modal');
const importClose = document.getElementById('import-close');
const importProjectSel = document.getElementById('import-project');
const importShowAll = document.getElementById('import-show-all');
const importListEl = document.getElementById('import-list');
const importSubmit = document.getElementById('import-submit');
const importStatusEl = document.getElementById('import-status');

let importProjects = [];
let importCurrentCwd = null;

importBtn.addEventListener('click', openImportModal);
importClose.addEventListener('click', closeImportModal);
importModal.addEventListener('click', (e) => { if (e.target === importModal) closeImportModal(); });
importShowAll.addEventListener('change', renderProjectOptions);
importProjectSel.addEventListener('change', loadImportSessions);
importSubmit.addEventListener('click', submitImport);

async function openImportModal() {
  importModal.hidden = false;
  importStatusEl.textContent = 'loading projects…';
  importListEl.innerHTML = '';
  try {
    const res = await fetch('/api/history/projects');
    const data = await res.json();
    importProjects = data.projects || [];
    importCurrentCwd = data.currentCwd || null;
    renderProjectOptions();
    await loadImportSessions();
  } catch (err) {
    importStatusEl.textContent = 'failed to load: ' + err.message;
  }
}

function closeImportModal() {
  importModal.hidden = true;
}

function renderProjectOptions() {
  const showAll = importShowAll.checked;
  const filtered = showAll
    ? importProjects
    : importProjects.filter((p) => p.cwd === importCurrentCwd);
  // If filtering hides everything, fall back to showing all so the modal isn't empty.
  const list = filtered.length ? filtered : importProjects;
  importProjectSel.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.slug;
    opt.textContent = `${p.cwd}  (${p.sessionCount})`;
    if (p.cwd === importCurrentCwd) opt.selected = true;
    importProjectSel.appendChild(opt);
  }
  if (!filtered.length && importProjects.length) {
    importStatusEl.textContent = 'no sessions for current cwd; showing all';
  }
}

async function loadImportSessions() {
  const slug = importProjectSel.value;
  if (!slug) { importListEl.innerHTML = ''; return; }
  importStatusEl.textContent = 'loading sessions…';
  importListEl.innerHTML = '';
  try {
    const res = await fetch(`/api/history/sessions?slug=${encodeURIComponent(slug)}`);
    const items = await res.json();
    importStatusEl.textContent = `${items.length} session(s)`;
    for (const s of items) {
      const li = document.createElement('li');
      if (s.alreadyImported) li.classList.add('disabled');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      cb.disabled = !!s.alreadyImported;
      const wrap = document.createElement('div');
      wrap.style.flex = '1';
      const title = document.createElement('div');
      title.className = 'import-title';
      title.textContent = s.title;
      const meta = document.createElement('div');
      meta.className = 'import-meta';
      const date = new Date(s.mtime).toLocaleString();
      meta.textContent = `${s.messageCount} msg · ${date}${s.alreadyImported ? ' · already imported' : ''}`;
      wrap.appendChild(title);
      wrap.appendChild(meta);
      li.appendChild(cb);
      li.appendChild(wrap);
      importListEl.appendChild(li);
    }
  } catch (err) {
    importStatusEl.textContent = 'failed: ' + err.message;
  }
}

async function submitImport() {
  const slug = importProjectSel.value;
  const ids = [...importListEl.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
  if (!ids.length) { importStatusEl.textContent = 'pick at least one'; return; }
  importSubmit.disabled = true;
  importStatusEl.textContent = `importing ${ids.length}…`;
  try {
    const res = await fetch('/api/history/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, ids }),
    });
    const data = await res.json();
    importStatusEl.textContent = `imported ${data.created?.length ?? 0}, skipped ${data.skipped?.length ?? 0}`;
    await loadImportSessions();
  } catch (err) {
    importStatusEl.textContent = 'failed: ' + err.message;
  } finally {
    importSubmit.disabled = false;
  }
}

connect();
