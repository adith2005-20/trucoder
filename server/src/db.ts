import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config";

fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, "trucoder.db");
export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Drop legacy single-owner tables from the earlier version of TruCoder.
db.exec(`DROP TABLE IF EXISTS problem_progress; DROP TABLE IF EXISTS submissions;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    solved INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_code TEXT,
    last_language TEXT,
    solved_at TEXT,
    last_attempt_at TEXT,
    PRIMARY KEY (user_id, course_id, lesson_id)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    language TEXT NOT NULL,
    code TEXT NOT NULL,
    verdict TEXT NOT NULL,
    public_passed INTEGER NOT NULL DEFAULT 0,
    public_total INTEGER NOT NULL DEFAULT 0,
    private_passed INTEGER NOT NULL DEFAULT 0,
    private_total INTEGER NOT NULL DEFAULT 0,
    compile_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS answers (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    block_id INTEGER NOT NULL,
    correct INTEGER NOT NULL DEFAULT 0,
    answer TEXT,
    answered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, course_id, lesson_id, block_id)
  );

  CREATE TABLE IF NOT EXISTS sticky_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT 'auto',
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-user course visibility. Absent row = visible (opt-out hiding).
  -- The owner account is exempt at the route layer and never written here.
  CREATE TABLE IF NOT EXISTS course_visibility (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, course_id)
  );
`);

// Expired session rows are dead weight — sweep them at boot (resolveToken
// also removes them lazily on use, but a user who never returns leaves rows).
db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(
  new Date().toISOString()
);

// ---- users ----
export interface User {
  id: number;
  username: string;
  password_hash: string;
}

export function userByUsername(username: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | User
    | undefined;
}

export function userById(id: number): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | User
    | undefined;
}

export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function createUser(username: string, passwordHash: string): void {
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
    username,
    passwordHash
  );
}

// ---- sessions ----
export interface Session {
  id: number;
  token_hash: string;
  user_id: number;
  expires_at: string;
}

export function createSession(userId: number, tokenHash: string, expiresAt: string): void {
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(tokenHash, userId, expiresAt);
}

export function sessionByTokenHash(tokenHash: string): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | Session
    | undefined;
}

export function deleteSession(tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

// ---- progress ----
export interface ProgressRow {
  user_id: number;
  course_id: string;
  lesson_id: string;
  solved: number;
  attempt_count: number;
  last_code: string | null;
  last_language: string | null;
  solved_at: string | null;
  last_attempt_at: string | null;
}

export function getProgress(
  userId: number,
  courseId: string,
  lessonId: string
): ProgressRow | undefined {
  return db
    .prepare(
      `SELECT * FROM progress WHERE user_id = ? AND course_id = ? AND lesson_id = ?`
    )
    .get(userId, courseId, lessonId) as ProgressRow | undefined;
}

/** Progress rows for many lessons of one course in a single query (the
 *  course list/detail endpoints call this instead of one query per lesson). */
export function getProgressForLessons(
  userId: number,
  courseId: string,
  lessonIds: string[]
): Map<string, ProgressRow> {
  if (lessonIds.length === 0) return new Map();
  const placeholders = lessonIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM progress
       WHERE user_id = ? AND course_id = ? AND lesson_id IN (${placeholders})`
    )
    .all(userId, courseId, ...lessonIds) as ProgressRow[];
  return new Map(rows.map((r) => [r.lesson_id, r]));
}

/** Mark a content-only lesson as read (progress solved, no submission row). */
export function markLessonRead(
  userId: number,
  courseId: string,
  lessonId: string
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO progress
       (user_id, course_id, lesson_id, solved, attempt_count, solved_at, last_attempt_at)
     VALUES (?, ?, ?, 1, 0, ?, ?)
     ON CONFLICT(user_id, course_id, lesson_id) DO UPDATE SET
       solved = 1,
       solved_at = CASE WHEN progress.solved_at IS NULL
                        THEN excluded.solved_at ELSE progress.solved_at END,
       last_attempt_at = excluded.last_attempt_at`
  ).run(userId, courseId, lessonId, now, now);
}

/** Clear the read mark of a content-only lesson (the undo of markLessonRead).
 *  The attempt_count guard keeps a graded lesson that was solved by a
 *  submission safe: only a read mark (attempt_count 0) is ever removed. */
export function unmarkLessonRead(
  userId: number,
  courseId: string,
  lessonId: string
): void {
  db.prepare(
    `DELETE FROM progress
      WHERE user_id = ? AND course_id = ? AND lesson_id = ? AND attempt_count = 0`
  ).run(userId, courseId, lessonId);
}

// ---- quiz block answers ----
export interface AnswerRow {
  user_id: number;
  course_id: string;
  lesson_id: string;
  block_id: number;
  correct: number;
  answer: string | null;
  answered_at: string;
}

/** Record a quiz block answer (upsert per block). */
export function recordAnswer(
  userId: number,
  courseId: string,
  lessonId: string,
  blockId: number,
  correct: boolean,
  answerJson: string
): void {
  db.prepare(
    `INSERT INTO answers
       (user_id, course_id, lesson_id, block_id, correct, answer)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, course_id, lesson_id, block_id) DO UPDATE SET
       correct = MAX(answers.correct, excluded.correct),
       answer = excluded.answer,
       answered_at = excluded.answered_at`
  ).run(userId, courseId, lessonId, blockId, correct ? 1 : 0, answerJson);
}

/** Correctly-answered quiz block ids for a lesson. */
export function getSolvedQuizBlocks(
  userId: number,
  courseId: string,
  lessonId: string
): Set<number> {
  const rows = db
    .prepare(
      `SELECT block_id FROM answers
       WHERE user_id = ? AND course_id = ? AND lesson_id = ? AND correct = 1`
    )
    .all(userId, courseId, lessonId) as { block_id: number }[];
  return new Set(rows.map((r) => r.block_id));
}

export function recordSubmission(input: {
  userId: number;
  courseId: string;
  lessonId: string;
  language: string;
  code: string;
  verdict: "accepted" | "wrong" | "error" | "timeout";
  publicPassed: number;
  publicTotal: number;
  privatePassed: number;
  privateTotal: number;
  compileError?: string;
}): void {
  db.prepare(
    `INSERT INTO submissions
       (user_id, course_id, lesson_id, language, code, verdict,
        public_passed, public_total, private_passed, private_total, compile_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.userId,
    input.courseId,
    input.lessonId,
    input.language,
    input.code,
    input.verdict,
    input.publicPassed,
    input.publicTotal,
    input.privatePassed,
    input.privateTotal,
    input.compileError || null
  );

  const now = new Date().toISOString();
  const isSolved = input.verdict === "accepted" ? 1 : 0;

  db.prepare(
    `INSERT INTO progress
       (user_id, course_id, lesson_id, solved, attempt_count, last_code,
        last_language, solved_at, last_attempt_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(user_id, course_id, lesson_id) DO UPDATE SET
       solved = MAX(progress.solved, excluded.solved),
       attempt_count = progress.attempt_count + 1,
       last_code = excluded.last_code,
       last_language = excluded.last_language,
       solved_at = CASE WHEN excluded.solved = 1 AND progress.solved_at IS NULL
                        THEN excluded.solved_at ELSE progress.solved_at END,
       last_attempt_at = excluded.last_attempt_at`
  ).run(
    input.userId,
    input.courseId,
    input.lessonId,
    isSolved,
    input.code,
    input.language,
    now,
    now
  );
}

// ---- submissions history ----
export interface SubmissionRow {
  id: number;
  verdict: string;
  language: string;
  code: string;
  public_passed: number;
  public_total: number;
  private_passed: number;
  private_total: number;
  created_at: string;
}

/** The most recent submissions for one lesson (attempt history). */
export function getRecentSubmissions(
  userId: number,
  courseId: string,
  lessonId: string,
  limit = 20
): SubmissionRow[] {
  return db
    .prepare(
      `SELECT id, verdict, language, code,
              public_passed, public_total, private_passed, private_total, created_at
       FROM submissions
       WHERE user_id = ? AND course_id = ? AND lesson_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, courseId, lessonId, limit) as SubmissionRow[];
}

// ---- sticky notes ----
export interface StickyNoteRow {
  id: number;
  user_id: number;
  course_id: string;
  lesson_id: string;
  x: number;
  y: number;
  color: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export function listStickyNotes(
  userId: number,
  courseId: string,
  lessonId: string
): StickyNoteRow[] {
  return db
    .prepare(
      `SELECT * FROM sticky_notes
       WHERE user_id = ? AND course_id = ? AND lesson_id = ?
       ORDER BY id`
    )
    .all(userId, courseId, lessonId) as StickyNoteRow[];
}

export function createStickyNote(
  userId: number,
  courseId: string,
  lessonId: string,
  x: number,
  y: number,
  color: string
): StickyNoteRow {
  const info = db
    .prepare(
      `INSERT INTO sticky_notes (user_id, course_id, lesson_id, x, y, color)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, courseId, lessonId, x, y, color);
  return db
    .prepare(`SELECT * FROM sticky_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as StickyNoteRow;
}

/** Update a note owned by this user; returns the updated row or undefined
 *  when the note does not exist / is not theirs. */
export function updateStickyNote(
  userId: number,
  noteId: number,
  patch: { x?: number; y?: number; color?: string; text?: string }
): StickyNoteRow | undefined {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return undefined;
  sets.push(`updated_at = datetime('now')`);
  const info = db
    .prepare(
      `UPDATE sticky_notes SET ${sets.join(", ")}
       WHERE id = ? AND user_id = ?`
    )
    .run(...vals, noteId, userId);
  if (info.changes === 0) return undefined;
  return db
    .prepare(`SELECT * FROM sticky_notes WHERE id = ?`)
    .get(noteId) as StickyNoteRow;
}

export function deleteStickyNote(
  userId: number,
  noteId: number
): boolean {
  const info = db
    .prepare(`DELETE FROM sticky_notes WHERE id = ? AND user_id = ?`)
    .run(noteId, userId);
  return info.changes > 0;
}

// ---- continue-where-you-left-off ----
/** The course + lesson of the user's most recently touched progress row. */
export function getMostRecentProgress(
  userId: number
): { course_id: string; lesson_id: string } | null {
  const row = db
    .prepare(
      `SELECT course_id, lesson_id FROM progress
       WHERE user_id = ? AND last_attempt_at IS NOT NULL
       ORDER BY last_attempt_at DESC LIMIT 1`
    )
    .get(userId) as { course_id: string; lesson_id: string } | undefined;
  return row ?? null;
}

// ---- admin stats ----
export function getAdminStats() {
  const users = db
    .prepare(`SELECT id, username, created_at FROM users ORDER BY id`)
    .all() as { id: number; username: string; created_at: string }[];
  const solvedByLesson = db
    .prepare(
      `SELECT course_id, lesson_id, COUNT(*) AS n FROM progress WHERE solved = 1 GROUP BY course_id, lesson_id`
    )
    .all() as { course_id: string; lesson_id: string; n: number }[];
  const submissionsByLesson = db
    .prepare(
      `SELECT course_id, lesson_id, COUNT(*) AS n FROM submissions GROUP BY course_id, lesson_id`
    )
    .all() as { course_id: string; lesson_id: string; n: number }[];
  const submissionCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get() as { n: number }
  ).n;
  const attemptTotal = (
    db.prepare(`SELECT COALESCE(SUM(attempt_count), 0) AS n FROM progress`).get() as {
      n: number;
    }
  ).n;
  return {
    users,
    solvedByLesson,
    submissionsByLesson,
    submissionCount,
    attemptTotal,
  };
}

// ---- per-user course visibility ----
/** Course ids explicitly hidden from a user (absent rows mean visible). */
export function getHiddenCourseIds(userId: number): Set<string> {
  const rows = db
    .prepare(`SELECT course_id FROM course_visibility WHERE user_id = ? AND visible = 0`)
    .all(userId) as { course_id: string }[];
  return new Set(rows.map((r) => r.course_id));
}

/** Set one user×course cell (upsert). Owner rows are rejected at the route. */
export function setCourseVisibility(
  userId: number,
  courseId: string,
  visible: boolean
): void {
  db.prepare(
    `INSERT INTO course_visibility (user_id, course_id, visible)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, course_id) DO UPDATE SET visible = excluded.visible`
  ).run(userId, courseId, visible ? 1 : 0);
}

/** Every user with their visibility rows (LEFT JOIN — a user with no rows has
 *  courseId NULL and is fully visible). */ 
export function getCourseVisibilityMatrix(): {
  userId: number;
  username: string;
  courseId: string | null;
  visible: number | null;
}[] {
  return db
    .prepare(
      `SELECT u.id AS userId, u.username, cv.course_id AS courseId, cv.visible
       FROM users u
       LEFT JOIN course_visibility cv ON cv.user_id = u.id
       ORDER BY u.id, cv.course_id`
    )
    .all() as {
    userId: number;
    username: string;
    courseId: string | null;
    visible: number | null;
  }[];
}
