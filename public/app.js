// Minimal WS client for step 2: one hardcoded session, streams tokens into a single log.
const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = form.querySelector('button');
const statusEl = document.getElementById('status');

const HARDCODED_SESSION = 'main';
let ws;
let assistantMsgEl = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

function appendMessage(role, text = '') {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const tag = document.createElement('div');
  tag.className = 'role';
  tag.textContent = role;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  el.appendChild(tag);
  el.appendChild(body);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function ensureAssistantBubble() {
  if (!assistantMsgEl) {
    assistantMsgEl = appendMessage('assistant', '');
    assistantMsgEl.classList.add('streaming');
  }
  return assistantMsgEl;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    setStatus('connected', 'connected');
    sendBtn.disabled = false;
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected — retrying…', 'disconnected');
    sendBtn.disabled = true;
    setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => {
    setStatus('error', 'disconnected');
  });

  ws.addEventListener('message', (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    handleEvent(evt);
  });
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'token': {
      const el = ensureAssistantBubble();
      el.querySelector('.body').textContent += evt.text;
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'tool_start': {
      const text = `→ ${evt.name}(${JSON.stringify(evt.input)})`;
      appendMessage('tool', text);
      break;
    }
    case 'state': {
      if (evt.state === 'complete' || evt.state === 'error') {
        if (assistantMsgEl) {
          assistantMsgEl.classList.remove('streaming');
          assistantMsgEl = null;
        }
        sendBtn.disabled = false;
      }
      if (evt.state === 'error') {
        appendMessage('system', `error: ${evt.error || 'unknown'}`);
      }
      break;
    }
    case 'session': {
      appendMessage('system', `session ${evt.sessionId}`);
      break;
    }
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  appendMessage('user', text);
  ws.send(JSON.stringify({ type: 'send_message', sessionId: HARDCODED_SESSION, text }));
  input.value = '';
  sendBtn.disabled = true;
});

input.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    form.requestSubmit();
  }
});

connect();
