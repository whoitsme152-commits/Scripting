const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");

const dbPath = process.env.DATABASE_PATH || "./data/roblox_tutor.sqlite";
const absolute = path.resolve(dbPath);
fs.mkdirSync(path.dirname(absolute), { recursive: true });
const db = new Database(absolute);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
 guild_id TEXT PRIMARY KEY, text_channel_id TEXT, voice_channel_id TEXT,
 admin_role_id TEXT, timezone TEXT NOT NULL DEFAULT 'America/Detroit',
 lesson_hour INTEGER NOT NULL DEFAULT 18, lesson_minute INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
 current_day INTEGER NOT NULL DEFAULT 1, completed_days INTEGER NOT NULL DEFAULT 0,
 skipped_days INTEGER NOT NULL DEFAULT 0, total_minutes INTEGER NOT NULL DEFAULT 0,
 streak INTEGER NOT NULL DEFAULT 0, last_lesson_date TEXT, enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
 day_number INTEGER NOT NULL, remaining_seconds INTEGER NOT NULL DEFAULT 7200,
 status TEXT NOT NULL DEFAULT 'paused', last_started_at INTEGER,
 text_checkin_at INTEGER, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ended_at TEXT, quiz_passed INTEGER NOT NULL DEFAULT 0,
 temp_voice_channel_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(guild_id,user_id,status);
CREATE TABLE IF NOT EXISTS quiz_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
 day_number INTEGER NOT NULL, selected_answer INTEGER NOT NULL, correct INTEGER NOT NULL,
 attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS daily_status (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day_number INTEGER NOT NULL,
 date_key TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(guild_id,user_id,date_key)
);
`);

// Migrate older databases that predate temp voice channels
try {
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  if (!cols.includes("temp_voice_channel_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN temp_voice_channel_id TEXT");
  }
} catch (e) {
  console.error("Session schema migration warning:", e.message);
}

const stmts = {
  getConfig: db.prepare("SELECT * FROM guild_config WHERE guild_id=?"),
  setConfig: db.prepare(`INSERT INTO guild_config(guild_id,text_channel_id,voice_channel_id,admin_role_id,timezone,lesson_hour,lesson_minute)
    VALUES(@guild_id,@text_channel_id,@voice_channel_id,@admin_role_id,@timezone,@lesson_hour,@lesson_minute)
    ON CONFLICT(guild_id) DO UPDATE SET text_channel_id=excluded.text_channel_id,voice_channel_id=excluded.voice_channel_id,
    admin_role_id=excluded.admin_role_id,timezone=excluded.timezone,lesson_hour=excluded.lesson_hour,lesson_minute=excluded.lesson_minute`),
  getUser: db.prepare("SELECT * FROM users WHERE guild_id=? AND user_id=?"),
  ensureUser: db.prepare("INSERT OR IGNORE INTO users(guild_id,user_id) VALUES(?,?)"),
  updateUser: db.prepare(`UPDATE users SET current_day=@current_day,completed_days=@completed_days,skipped_days=@skipped_days,
    total_minutes=@total_minutes,streak=@streak,last_lesson_date=@last_lesson_date WHERE guild_id=@guild_id AND user_id=@user_id`),
  active: db.prepare("SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status IN ('running','paused') ORDER BY id DESC LIMIT 1"),
  createSession: db.prepare("INSERT INTO sessions(guild_id,user_id,day_number,remaining_seconds,status,text_checkin_at,temp_voice_channel_id) VALUES(?,?,?,7200,'paused',?,?)"),
  updateSession: db.prepare("UPDATE sessions SET remaining_seconds=?,status=?,last_started_at=?,text_checkin_at=? WHERE id=?"),
  setTempVoice: db.prepare("UPDATE sessions SET temp_voice_channel_id=? WHERE id=?"),
  finishSession: db.prepare("UPDATE sessions SET remaining_seconds=0,status='quiz',ended_at=CURRENT_TIMESTAMP WHERE id=?"),
  setQuizPassed: db.prepare("UPDATE sessions SET quiz_passed=1,status='completed' WHERE id=?"),
  addAttempt: db.prepare("INSERT INTO quiz_attempts(guild_id,user_id,day_number,selected_answer,correct) VALUES(?,?,?,?,?)"),
  markDaily: db.prepare(`INSERT INTO daily_status(guild_id,user_id,day_number,date_key,status) VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id,user_id,date_key) DO UPDATE SET status=excluded.status`),
  getStats: db.prepare("SELECT COUNT(*) attempts, SUM(correct) correct FROM quiz_attempts WHERE guild_id=? AND user_id=?")
};

function ensureUser(guildId,userId){ stmts.ensureUser.run(guildId,userId); return stmts.getUser.get(guildId,userId); }
function saveUser(user){ stmts.updateUser.run(user); }
module.exports = { db, stmts, ensureUser, saveUser };
