// Local-only persistence (IndexedDB) for interview sessions.
// Resume, session focus, module picks and messages NEVER leave the browser.
const DB = "trucoder-interview";
const STORE = "sessions";

export interface InterviewMessage {
  role: "interviewer" | "user";
  content: string;
}

export interface InterviewSession {
  id: string;
  title: string;
  createdAt: number;
  resume: string;
  focus: string;
  /** selected module references: "courseId/lessonId" entries */
  modules: string[];
  /** "openrouter" = shared free tier (no key needed); "zen" = BYOK OpenCode Zen. */
  provider: "openrouter" | "zen";
  messages: InterviewMessage[];
  status: "draft" | "active" | "done";
  report?: unknown;
  model: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const sessionStore = {
  list: async (): Promise<InterviewSession[]> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () =>
        resolve((req.result as InterviewSession[]).sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  },
  get: (id: string) => tx("readonly", (s) => s.get(id)),
  put: (s: InterviewSession) => tx("readwrite", (st) => st.put(s)),
  del: (id: string) => tx("readwrite", (s) => s.delete(id)),
};

export function newSessionId(): string {
  return "iv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
