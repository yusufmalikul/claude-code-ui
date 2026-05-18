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
const HARDCODED_CWD = process.env.CLAUDE_CWD || process.cwd();

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

// Default session for step 3 — one row, reused across restarts.
const defaultSession = sessions.getOrCreateDefault({ cwd: HARDCODED_CWD });
app.log.info({ sessionId: defaultSession.id, claudeId: defaultSession.claude_id }, 'default session');

// Tracks the active spawnClaude handle per DB session id, so we can refuse
// overlapping turns and (later) cancel.
const running = new Map();

app.register(async (scoped) => {
  scoped.get('/ws', { websocket: true }, (socket) => {
    const send = (obj) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    // Hydrate the client with current session + history.
    send({ type: 'session_list', sessions: sessions.list() });
    send({
      type: 'history',
      sessionId: defaultSession.id,
      messages: sessions.messages(defaultSession.id),
    });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch { return send({ type: 'state', state: 'error', error: 'bad json' }); }

      if (msg.type === 'send_message') {
        handleSendMessage(msg, send);
      } else if (msg.type === 'cancel') {
        running.get(defaultSession.id)?.cancel();
      }
    });
  });
});

function handleSendMessage(msg, send) {
  const sessionId = defaultSession.id;
  if (running.has(sessionId)) {
    return send({ type: 'state', state: 'error', error: 'session is busy' });
  }
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return send({ type: 'state', state: 'error', error: 'empty message' });

  // Always re-read so we pick up claude_id captured on a previous turn.
  const sess = sessions.get(sessionId);
  sessions.addMessage(sessionId, 'user', { text });

  let assistantBuffer = '';
  const toolCalls = [];

  const run = spawnClaude({
    message: text,
    cwd: sess.cwd,
    resumeId: sess.claude_id || undefined,
    skipPerms: true,
    onSession: (id) => {
      // First-turn capture, or when claude rotates the session id mid-conversation.
      if (id && id !== sess.claude_id) {
        sessions.setClaudeId(sessionId, id);
        sess.claude_id = id;
      }
      send({ type: 'session', sessionId: id });
    },
    onState: (state) => send({ type: 'state', state }),
    onToken: (t) => {
      assistantBuffer += t;
      send({ type: 'token', text: t });
    },
    onTool: (t) => {
      toolCalls.push({ id: t.id, name: t.name, input: t.input });
      send({ type: 'tool_start', toolUseId: t.id, name: t.name, input: t.input });
    },
  });
  running.set(sessionId, run);

  run.done
    .then(() => {
      sessions.addMessage(sessionId, 'assistant', {
        text: assistantBuffer,
        tool_calls: toolCalls,
      });
    })
    .catch((err) => send({ type: 'state', state: 'error', error: err.message }))
    .finally(() => { running.delete(sessionId); });
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`listening on ${addr}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
