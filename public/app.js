// Multi-session client. Each session has its own log + in-progress assistant bubble;
// only the active session is shown, but streams continue in the background for others.
const logEl = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = form.querySelector('button[type="submit"]');
const statusEl = document.getElementById('status');
const sessionListEl = document.getElementById('session-list');
const sessionTitleEl = document.getElementById('session-title');
const newSessionBtn = document.getElementById('new-session-btn');

let ws;
let sessions = [];        // server-provided list, ordered by updated_at desc
let activeSessionId = null;

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
    li.appendChild(dot); li.appendChild(title);
    li.addEventListener('click', () => selectSession(s.id));
    sessionListEl.appendChild(li);
  }
}

function renderLog() {
  logEl.innerHTML = '';
  if (activeSessionId == null) return;
  const state = getState(activeSessionId);
  for (const m of state.messages) {
    appendBubble(m.role, m.text, m.streaming, m.id);
    for (const tc of m.tool_calls ?? []) {
      appendBubble('tool', `→ ${tc.name}(${JSON.stringify(tc.input)})`);
    }
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function appendBubble(role, text, streaming = false, id = null) {
  const el = document.createElement('div');
  el.className = `msg ${role}` + (streaming ? ' streaming' : '');
  if (id) el.dataset.msgId = id;
  const tag = document.createElement('div');
  tag.className = 'role'; tag.textContent = role;
  const body = document.createElement('div');
  body.className = 'body'; body.textContent = text;
  el.appendChild(tag); el.appendChild(body);
  logEl.appendChild(el);
  return el;
}

function selectSession(id) {
  activeSessionId = id;
  const s = sessions.find((x) => x.id === id);
  sessionTitleEl.textContent = s ? s.title : '…';
  renderSessionList();
  renderLog();
  // Ask the server for fresh history (covers reconnect cases).
  ws?.send?.(JSON.stringify({ type: 'load_session', sessionId: id }));
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
        if (el) el.textContent = bubble.text;
        logEl.scrollTop = logEl.scrollHeight;
      }
      break;
    }
    case 'tool_start': {
      const state = getState(evt.sessionId);
      const tc = { id: evt.toolUseId, name: evt.name, input: evt.input };
      if (state.openAssistant) state.openAssistant.tool_calls.push(tc);
      if (evt.sessionId === activeSessionId) {
        appendBubble('tool', `→ ${evt.name}(${JSON.stringify(evt.input)})`);
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
  if (!text || ws?.readyState !== WebSocket.OPEN || activeSessionId == null) return;

  const state = getState(activeSessionId);
  const userMsg = { id: `live-u-${Date.now()}`, role: 'user', text, tool_calls: [], streaming: false };
  state.messages.push(userMsg);
  appendBubble('user', text);
  logEl.scrollTop = logEl.scrollHeight;

  ws.send(JSON.stringify({ type: 'send_message', sessionId: activeSessionId, text }));
  input.value = '';
  sendBtn.disabled = true;
});

input.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    form.requestSubmit();
  }
});

newSessionBtn.addEventListener('click', () => {
  const title = prompt('Session title?', 'untitled');
  if (!title) return;
  ws.send(JSON.stringify({ type: 'new_session', title }));
});

connect();
