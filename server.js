import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { spawnClaude } from './claude-adapter.js';
import { openDb } from './db.js';
import { SessionManager } from './session-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const DEFAULT_CWD = process.env.CLAUDE_CWD || process.cwd();

const app = Fastify({ logger: { level: 'info' } });
const db = openDb();
const sessions = new SessionManager(db);

await app.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});
await app.register(fastifyWebsocket);

app.get('/health', async () => ({ ok: true }));
app.get('/api/sessions', async () => sessions.list());
app.get('/api/sessions/:id/messages', async (req) => sessions.messages(Number(req.params.id)));

app.post('/api/sessions', async (req, reply) => {
  const { title, cwd } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: 'title required' });
  return sessions.create({ title: title.trim(), cwd: (cwd || DEFAULT_CWD).trim() });
});

app.patch('/api/sessions/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: 'title required' });
  if (!sessions.get(id)) return reply.code(404).send({ error: 'not found' });
  const updated = sessions.rename(id, title.trim());
  broadcastSessionList();
  return updated;
});

app.delete('/api/sessions/:id', async (req) => {
  const id = Number(req.params.id);
  running.get(id)?.cancel();
  running.delete(id);
  sessions.delete(id);
  broadcastSessionList();
  return { ok: true };
});

// Ensure at least one session exists so first-time users have something to land on.
if (sessions.list().length === 0) {
  sessions.create({ title: 'main', cwd: DEFAULT_CWD });
}

// Active runs keyed by session id. Multiple sessions may stream concurrently.
const running = new Map();
// Connected websocket clients; used to fan out events.
const clients = new Set();

function broadcast(obj) {
  const json = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(json);
  }
}

function broadcastSessionList() {
  broadcast({ type: 'session_list', sessions: sessions.list() });
}

app.register(async (scoped) => {
  scoped.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);

    const send = (obj) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    send({ type: 'session_list', sessions: sessions.list() });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch { return send({ type: 'state', state: 'error', error: 'bad json' }); }

      switch (msg.type) {
        case 'send_message': return handleSendMessage(msg, send);
        case 'new_session':  return handleNewSession(msg, send);
        case 'load_session': return handleLoadSession(msg, send);
        case 'cancel': {
          const sid = Number(msg.sessionId);
          running.get(sid)?.cancel();
          return;
        }
      }
    });

    socket.on('close', () => clients.delete(socket));
  });
});

function handleNewSession(msg, send) {
  const title = (msg.title || 'untitled').toString().trim() || 'untitled';
  const cwd = (msg.cwd || DEFAULT_CWD).toString().trim() || DEFAULT_CWD;
  const sess = sessions.create({ title, cwd });
  broadcastSessionList();
  send({ type: 'session_created', session: sess });
  send({ type: 'history', sessionId: sess.id, messages: [] });
}

function handleLoadSession(msg, send) {
  const id = Number(msg.sessionId);
  const sess = sessions.get(id);
  if (!sess) return send({ type: 'state', state: 'error', error: 'session not found' });
  send({ type: 'history', sessionId: id, messages: sessions.messages(id) });
}

function handleSendMessage(msg, send) {
  const sessionId = Number(msg.sessionId);
  const sess = sessions.get(sessionId);
  if (!sess) return send({ type: 'state', sessionId, state: 'error', error: 'session not found' });
  if (running.has(sessionId)) {
    return send({ type: 'state', sessionId, state: 'error', error: 'session is busy' });
  }
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return send({ type: 'state', sessionId, state: 'error', error: 'empty message' });

  sessions.addMessage(sessionId, 'user', { text });
  // Notify everyone the session got touched so sidebars re-order.
  broadcastSessionList();

  let assistantBuffer = '';
  const toolCalls = [];
  const toolCallById = new Map();

  const run = spawnClaude({
    message: text,
    cwd: sess.cwd,
    resumeId: sess.claude_id || undefined,
    skipPerms: true,
    onSession: (id) => {
      if (id && id !== sess.claude_id) {
        sessions.setClaudeId(sessionId, id);
        sess.claude_id = id;
      }
      broadcast({ type: 'session', sessionId, claudeId: id });
    },
    onState: (state) => broadcast({ type: 'state', sessionId, state }),
    onToken: (t) => {
      assistantBuffer += t;
      broadcast({ type: 'token', sessionId, text: t });
    },
    onTool: (t) => {
      const entry = { id: t.id, name: t.name, input: t.input, result: null };
      toolCalls.push(entry);
      toolCallById.set(t.id, entry);
      broadcast({ type: 'tool_start', sessionId, toolUseId: t.id, name: t.name, input: t.input });
    },
    onToolResult: (r) => {
      const entry = toolCallById.get(r.id);
      if (entry) entry.result = { output: r.output, isError: r.isError, stdout: r.stdout, stderr: r.stderr, isImage: r.isImage };
      broadcast({
        type: 'tool_result',
        sessionId,
        toolUseId: r.id,
        output: r.output,
        isError: r.isError,
        stdout: r.stdout,
        stderr: r.stderr,
        isImage: r.isImage,
      });
    },
  });
  running.set(sessionId, run);

  run.done
    .then(() => {
      sessions.addMessage(sessionId, 'assistant', { text: assistantBuffer, tool_calls: toolCalls });
      broadcastSessionList();
    })
    .catch((err) => broadcast({ type: 'state', sessionId, state: 'error', error: err.message }))
    .finally(() => { running.delete(sessionId); });
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`listening on ${addr}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
