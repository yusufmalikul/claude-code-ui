import Fastify from 'fastify';
import { spawnClaude } from './claude-adapter.js';

const PORT = Number(process.env.PORT ?? 3001);
const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true }));

// Minimal echo route: POST a prompt, server streams tokens back as plain text.
// Step 1 sanity check — proves the adapter pipeline end-to-end via HTTP.
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
    cwd: cwd || process.cwd(),
    skipPerms: true,
    onToken: (t) => reply.raw.write(t),
    onState: (s) => req.log.info({ state: s }, 'claude state'),
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

app.listen({ port: PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`listening on ${addr}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
