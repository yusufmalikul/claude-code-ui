export class SessionManager {
  constructor(db) {
    this.db = db;
    this.stmts = {
      insertSession: db.prepare(
        `INSERT INTO sessions (title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ),
      getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
      listSessions: db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`),
      updateClaudeId: db.prepare(
        `UPDATE sessions SET claude_id = ?, updated_at = ? WHERE id = ?`
      ),
      touchSession: db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`),
      insertMessage: db.prepare(
        `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`
      ),
      listMessages: db.prepare(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`
      ),
      deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
    };
  }

  create({ title, cwd }) {
    const now = Date.now();
    const info = this.stmts.insertSession.run(title, cwd, now, now);
    return this.get(info.lastInsertRowid);
  }

  get(id) { return this.stmts.getSession.get(id); }
  list()  { return this.stmts.listSessions.all(); }

  setClaudeId(id, claudeId) {
    this.stmts.updateClaudeId.run(claudeId, Date.now(), id);
  }

  touch(id) { this.stmts.touchSession.run(Date.now(), id); }

  // Default session for step 3 (single hardcoded session until step 4).
  getOrCreateDefault({ cwd }) {
    const existing = this.stmts.listSessions.all()[0];
    if (existing) return existing;
    return this.create({ title: 'main', cwd });
  }

  addMessage(sessionId, role, content) {
    const payload = typeof content === 'string' ? content : JSON.stringify(content);
    this.stmts.insertMessage.run(sessionId, role, payload, Date.now());
    this.touch(sessionId);
  }

  messages(sessionId) {
    return this.stmts.listMessages.all(sessionId).map((m) => ({
      ...m,
      content: tryParse(m.content),
    }));
  }

  delete(id) { this.stmts.deleteSession.run(id); }
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
