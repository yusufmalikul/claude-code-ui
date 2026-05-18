import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Each project dir is the cwd with `/` and `.` replaced by `-`. We can't reliably
// reverse the slug (a real `-` is ambiguous), so we also peek into the first
// transcript line that carries a `cwd` field to recover the true path.
export async function listProjects() {
  let entries;
  try {
    entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, ent.name);
    let files;
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }
    if (files.length === 0) continue;
    const cwd = (await peekCwd(path.join(dir, files[0]))) ?? `~${ent.name}`;
    out.push({ slug: ent.name, cwd, sessionCount: files.length });
  }
  out.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return out;
}

export async function listSessionsForSlug(slug) {
  const dir = path.join(PROJECTS_DIR, slug);
  let files;
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const id = f.replace(/\.jsonl$/, '');
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    const summary = await summarize(full);
    out.push({
      id,
      title: summary.title,
      cwd: summary.cwd,
      mtime: stat.mtimeMs,
      messageCount: summary.messageCount,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Read the full transcript and convert to our `{role, content}` message rows.
// Skips meta entries (queue-operation, system, sidechain, etc.).
export async function readTranscript(slug, sessionId) {
  const full = path.join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
  const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
  const messages = [];
  let cwd = null;
  let pendingAssistantText = '';
  let pendingToolCalls = [];
  const toolById = new Map();

  const flushAssistant = () => {
    if (pendingAssistantText || pendingToolCalls.length) {
      messages.push({
        role: 'assistant',
        content: { text: pendingAssistantText, tool_calls: pendingToolCalls },
      });
    }
    pendingAssistantText = '';
    pendingToolCalls = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.isSidechain) continue;
    if (!cwd && typeof evt.cwd === 'string') cwd = evt.cwd;

    if (evt.type === 'user' && evt.message?.content) {
      const blocks = Array.isArray(evt.message.content)
        ? evt.message.content
        : [{ type: 'text', text: String(evt.message.content) }];
      // tool_result blocks belong with the preceding assistant turn
      let userText = '';
      const images = [];
      for (const b of blocks) {
        if (b.type === 'text') userText += (userText ? '\n' : '') + (b.text ?? '');
        else if (b.type === 'image') images.push({ mediaType: b.source?.media_type ?? 'image/png' });
        else if (b.type === 'tool_result') {
          const entry = toolById.get(b.tool_use_id);
          if (entry) {
            entry.result = {
              output: typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.map((c) => c?.text ?? '').join('')
                  : '',
              isError: !!b.is_error,
            };
          }
        }
      }
      if (userText || images.length) {
        flushAssistant();
        messages.push({ role: 'user', content: { text: userText, images } });
      }
      continue;
    }

    if (evt.type === 'assistant' && evt.message?.content) {
      for (const b of evt.message.content) {
        if (b.type === 'text') pendingAssistantText += b.text ?? '';
        else if (b.type === 'tool_use') {
          const entry = { id: b.id, name: b.name, input: b.input, result: null };
          pendingToolCalls.push(entry);
          toolById.set(b.id, entry);
        }
      }
    }
  }
  flushAssistant();
  return { cwd, messages };
}

async function peekCwd(file) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let done = false;
    const finish = (v) => { if (!done) { done = true; rl.close(); resolve(v); } };
    rl.on('line', (line) => {
      try {
        const evt = JSON.parse(line);
        if (typeof evt.cwd === 'string') return finish(evt.cwd);
      } catch {}
    });
    rl.on('close', () => finish(null));
    rl.on('error', () => finish(null));
  });
}

async function summarize(file) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let title = null;
    let cwd = null;
    let messageCount = 0;
    rl.on('line', (line) => {
      try {
        const evt = JSON.parse(line);
        if (!cwd && typeof evt.cwd === 'string') cwd = evt.cwd;
        if (evt.isSidechain) return;
        if (evt.type === 'user' && evt.message?.content) {
          const blocks = Array.isArray(evt.message.content) ? evt.message.content : [];
          const hasUserText = blocks.some((b) => b.type === 'text' && b.text?.trim());
          if (hasUserText) {
            messageCount += 1;
            if (!title) {
              const t = blocks.find((b) => b.type === 'text')?.text?.trim() ?? '';
              title = t.replace(/\s+/g, ' ').slice(0, 80) || null;
            }
          }
        } else if (evt.type === 'assistant') {
          messageCount += 1;
        }
      } catch {}
    });
    rl.on('close', () => resolve({ title: title || '(empty)', cwd, messageCount }));
    rl.on('error', () => resolve({ title: title || '(empty)', cwd, messageCount }));
  });
}
