import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { spawnClaude } from './claude-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const HARDCODED_CWD = process.env.CLAUDE_CWD || process.cwd();

const app = Fastify({ logger: { level: 'info' } });

await app.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});
await app.register(fastifyWebsocket);

app.get('/health', async () => ({ ok: true }));

// Step 2: keep POST /echo around as a sanity endpoint.
app.post('/echo', async (req, reply) => {
  const { prompt, cwd } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return reply.code(400).send({ error: 'prompt required' });
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no',
  });
  const run = spawnClaude({
    message: prompt,
    cwd: cwd || HARDCODED_CWD,
    skipPerms: true,
    onToken: (t) => reply.raw.write(t),
    onSession: (id) => reply.raw.write(`\n[session:${id}]\n`),
  });
  try {
    const result = await run.done;
    reply.raw.write(`\n[done sessionId=${result.sessionId}]\n`);
  } catch (err) {
    reply.raw.write(`\n[error] ${err.message}\n`);
  }
  reply.raw.end();
});

// One in-memory session for step 2. Replaced by SessionManager in step 3.
const hardcodedSession = {
  id: 'main',
  cwd: HARDCODED_CWD,
  claudeId: null,        // captured from claude on first turn (used by --resume in step 3)
  running: null,         // active spawnClaude handle, or null
};

app.register(async (scoped) => {
  scoped.get('/ws', { websocket: true }, (socket /*, req */) => {
    const send = (obj) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch { return send({ type: 'state', state: 'error', error: 'bad json' }); }

      if (msg.type === 'send_message') {
        handleSendMessage(msg, send);
      } else if (msg.type === 'cancel') {
        hardcodedSession.running?.cancel();
      }
    });

    socket.on('close', () => { /* future: cleanup per-socket pending work */ });
  });
});

function handleSendMessage(msg, send) {
  if (hardcodedSession.running) {
    return send({ type: 'state', state: 'error', error: 'session is busy' });
  }
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return send({ type: 'state', state: 'error', error: 'empty message' });

  const run = spawnClaude({
    message: text,
    cwd: hardcodedSession.cwd,
    skipPerms: true,
    onSession: (id) => {
      hardcodedSession.claudeId = id;
      send({ type: 'session', sessionId: id });
    },
    onState: (state) => send({ type: 'state', state }),
    onToken: (t) => send({ type: 'token', text: t }),
    onTool: (t) => send({ type: 'tool_start', toolUseId: t.id, name: t.name, input: t.input }),
  });
  hardcodedSession.running = run;

  run.done
    .catch((err) => send({ type: 'state', state: 'error', error: err.message }))
    .finally(() => { hardcodedSession.running = null; });
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`listening on ${addr}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
