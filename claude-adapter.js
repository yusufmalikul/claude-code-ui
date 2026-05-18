import { spawn } from 'node:child_process';

/**
 * spawnClaude — run one turn of the claude CLI in stream-json mode.
 *
 * Writes a single user message to stdin, closes stdin, parses stream-json
 * line-by-line, and dispatches typed callbacks. Returns a promise that
 * resolves with { sessionId, resultText, isError } when the process exits.
 *
 * options:
 *   message:    string                user prompt for this turn
 *   cwd:        string                working directory for claude
 *   resumeId?:  string                pass to --resume for context continuity
 *   skipPerms?: boolean               temporary; remove once MCP gate lands
 *   onEvent?:   (evt) => void         raw stream-json event (debug)
 *   onToken?:   (text) => void        text delta chunks as they stream
 *   onState?:   (state) => void       'requesting' | 'streaming' | 'complete' | 'error'
 *   onTool?:    ({id,name,input}) => void   when assistant emits a tool_use block
 *   onSession?: (sessionId) => void   fires as soon as session_id is known
 */
export function spawnClaude(options) {
  const {
    message,
    cwd,
    resumeId,
    skipPerms = false,
    onEvent,
    onToken,
    onState,
    onTool,
    onSession,
  } = options;

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--input-format', 'stream-json',
  ];
  if (resumeId) args.push('--resume', resumeId);
  if (skipPerms) args.push('--dangerously-skip-permissions');

  const child = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sessionId = null;
  let resultText = '';
  let isError = false;
  let stderrBuf = '';
  let stdoutBuf = '';
  let streamingStarted = false;
  const seenToolIds = new Set();

  const handleEvent = (evt) => {
    onEvent?.(evt);

    if (evt.session_id && !sessionId) {
      sessionId = evt.session_id;
      onSession?.(sessionId);
    }

    if (evt.type === 'system' && evt.subtype === 'status' && evt.status) {
      onState?.(evt.status);
      return;
    }

    if (evt.type === 'stream_event') {
      const inner = evt.event;
      if (!inner) return;
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        if (!streamingStarted) {
          streamingStarted = true;
          onState?.('streaming');
        }
        onToken?.(inner.delta.text);
      }
      return;
    }

    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_use' && !seenToolIds.has(block.id)) {
          seenToolIds.add(block.id);
          onTool?.({ id: block.id, name: block.name, input: block.input });
        }
      }
      return;
    }

    if (evt.type === 'result') {
      if (evt.session_id) sessionId = evt.session_id;
      if (typeof evt.result === 'string') resultText = evt.result;
      if (evt.is_error) isError = true;
      return;
    }
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch (err) {
        // Malformed line — surface but don't crash the stream.
        onEvent?.({ type: 'parse_error', error: String(err), line });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });

  // Stream-json input: one JSON line, then close stdin (plan line 223).
  const inputMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: message }],
    },
  };
  child.stdin.write(JSON.stringify(inputMessage) + '\n');
  child.stdin.end();

  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      onState?.('error');
      reject(err);
    });
    child.on('close', (code) => {
      if (stdoutBuf.trim()) {
        try { handleEvent(JSON.parse(stdoutBuf.trim())); } catch { /* ignore */ }
        stdoutBuf = '';
      }
      if (code !== 0 || isError) {
        onState?.('error');
        const err = new Error(`claude exited with code ${code}: ${stderrBuf.slice(0, 500)}`);
        err.sessionId = sessionId;
        err.stderr = stderrBuf;
        return reject(err);
      }
      onState?.('complete');
      resolve({ sessionId, resultText, isError, stderr: stderrBuf });
    });
  });

  return {
    child,
    done,
    cancel: () => child.kill('SIGTERM'),
  };
}
