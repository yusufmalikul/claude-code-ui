import { spawnClaude } from './claude-adapter.js';

const prompt = process.argv.slice(2).join(' ') || 'reply with the single word: pong';

process.stdout.write(`> ${prompt}\n\n`);

const run = spawnClaude({
  message: prompt,
  cwd: process.cwd(),
  skipPerms: true,
  onSession: (id) => process.stderr.write(`[session] ${id}\n`),
  onState:   (s)  => process.stderr.write(`[state] ${s}\n`),
  onToken:   (t)  => process.stdout.write(t),
  onTool:    (t)  => process.stderr.write(`[tool] ${t.name} ${JSON.stringify(t.input)}\n`),
});

try {
  const result = await run.done;
  process.stdout.write('\n\n');
  process.stderr.write(`[done] sessionId=${result.sessionId} chars=${result.resultText.length}\n`);
} catch (err) {
  process.stderr.write(`[error] ${err.message}\n`);
  process.exit(1);
}
