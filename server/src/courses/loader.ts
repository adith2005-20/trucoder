import fs from "fs";
import path from "path";
import matter from "gray-matter";
import chokidar from "chokidar";
import { config } from "../config";
import type {
  Block,
  CodeBlock,
  Course,
  Difficulty,
  FlowEdge,
  FlowchartBlock,
  Folder,
  ImageBlock,
  Lang,
  Lesson,
  MarkdownBlock,
  McqBlock,
  MscqBlock,
  ModuleSpec,
  TestCase,
} from "./types";

/**
 * Loads courses from the on-disk `courses/` directory. Content is fully
 * data-driven — no code changes are needed to add or edit a course; just drop
 * .mdx files (see courses/AGENTS.md for the schema) and TruCoder picks them up.
 *
 * - Scans the tree at startup.
 * - Watches it with chokidar and re-scans on any change (agent-authored edits
 *   take effect without a restart).
 * - A malformed file is logged and skipped; it never breaks the app.
 */

type CourseMap = Map<string, Course>;
let cache: CourseMap = new Map();
let loadErrors: Record<string, string> = {};

// ---- folders ----
// Folders are metadata-only groupings of courses (see `courses/folders.json`).
// A course joins one by setting `folder: <id>` in its course.mdx frontmatter; a
// course with no folder (or an unknown one) sits in the index root.
const FOLDERS_FILE = "folders.json";
let folders: Folder[] = [];
let folderIds = new Set<string>();

/** Read `courses/folders.json`. A missing or malformed file means "no
 *  folders" — the index then behaves exactly as it did before folders
 *  existed, so an old checkout never breaks. */
function loadFolders(): void {
  folders = [];
  folderIds = new Set();
  const file = path.join(config.coursesDir, FOLDERS_FILE);
  if (!fs.existsSync(file)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { folders?: unknown };
    const list = Array.isArray(raw?.folders) ? raw.folders : [];
    const seen = new Set<string>();
    for (const [i, entry] of list.entries()) {
      const f = entry as Record<string, unknown>;
      const id = typeof f?.id === "string" ? f.id.trim() : "";
      if (!id) {
        loadErrors[`${FOLDERS_FILE}#${i}`] = "folder entry without an id";
        continue;
      }
      if (seen.has(id)) {
        loadErrors[`${FOLDERS_FILE}#${i}`] = `duplicate folder id '${id}'`;
        continue;
      }
      seen.add(id);
      folders.push({
        id,
        title: typeof f.title === "string" && f.title.trim() ? f.title : id,
        description: typeof f.description === "string" ? f.description : "",
        order: typeof f.order === "number" ? f.order : list.length,
      });
    }
    folders.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    folderIds = new Set(folders.map((f) => f.id));
  } catch (e) {
    loadErrors[FOLDERS_FILE] = (e as Error).message;
    console.error(`[trucoder] failed to load ${FOLDERS_FILE}:`, (e as Error).message);
  }
}

export function getFolders(): Folder[] {
  return folders;
}

// ---- content search index ----
// Per-lesson significant words (markdown, task, hints, quiz text) built at
// scan time so the command palette can search lesson CONTENT without the
// client fetching every lesson body. Solutions/starter code are never
// indexed (the solution must not leak into the client).
export interface SearchEntry {
  courseId: string;
  /** Course title — lets the palette group results by course without a
   *  second lookup. */
  courseTitle: string;
  /** Folder id the course belongs to (null for root courses) — powers the
   *  grouped "by folder" results in the palette. */
  folder: string | null;
  lessonId: string;
  title: string;
  words: string[];
}

let searchIndex: SearchEntry[] = [];

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "you",
  "your", "from", "have", "has", "will", "can", "not", "but", "all",
  "its", "they", "them", "their", "what", "when", "where", "which",
  "there", "here", "into", "than", "then", "each", "just", "like",
  "more", "most", "over", "such", "only", "also", "how", "why", "one",
  "out", "use", "used", "using", "may", "might", "should", "could",
  "would", "about", "after", "before", "because", "between", "while",
  "during", "within", "without", "under", "above", "again", "other",
  "some", "any", "many", "much", "few", "own", "same", "so", "too",
  "very", "really", "well", "get", "got", "make", "made", "take",
  "need", "needs", "want", "see", "look", "come", "go", "know",
  "think", "say", "says", "thing", "things", "way", "ways", "part",
  "parts", "kind", "types", "type", "called", "call", "calls", "two",
  "first", "second", "next", "last", "new", "old", "back", "still",
  "even", "ever", "never", "always", "often", "sometimes", "instead",
  "least", "however", "though", "although", "since", "until", "once",
]);

/** Significant lowercase tokens of a text, deduped and capped (the palette
 *  matches word prefixes client-side; a bounded set keeps the index small). */
function lessonWords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 150) break;
  }
  return [...seen];
}

function lessonSearchText(lesson: Lesson): string {
  const parts = [lesson.title, ...lesson.tags];
  for (const b of lesson.blocks) {
    switch (b.type) {
      case "markdown":
        parts.push(b.content);
        break;
      case "code":
        parts.push(b.task, ...b.hints);
        break;
      case "mcq":
      case "mscq":
        parts.push(b.prompt, ...b.options);
        break;
      case "image":
        parts.push(b.alt, b.caption ?? "");
        break;
      case "flowchart":
        parts.push(b.title ?? "", ...b.nodes);
        break;
    }
  }
  return parts.join(" ");
}

const SUPPORTED_LANGS = new Set<Lang>(["java", "javascript", "python", "cpp"]);
const DIFFS = new Set<string>(["beginner", "easy", "medium", "hard"]);

/** Convert a frontmatter `expected` value to a compact JSON string. */
export function toExpectedJson(v: unknown): string {
  // A numeric string is treated as a raw JSON number literal, which preserves
  // big integers exactly (a bare YAML number would lose precision above 2^53).
  if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
  return JSON.stringify(v);
}

function mapTests(arr: unknown): TestCase[] {
  return (Array.isArray(arr) ? arr : []).map((t) => ({
    name: String((t as any).name ?? "test"),
    args: (t as any).args ?? [],
    expected: toExpectedJson((t as any).expected),
  }));
}

function parseFrontmatter(file: string): { data: Record<string, unknown>; content: string } {
  const raw = fs.readFileSync(file, "utf8");
  return matter(raw);
}

function loadLesson(courseId: string, file: string): Lesson | null {
  try {
    const { data, content } = parseFrontmatter(file);
    const d = data as Record<string, any>;

    if (!d.id || !d.title) {
      throw new Error("missing required fields: id, title");
    }
    if (d.difficulty && !DIFFS.has(d.difficulty)) {
      throw new Error(`unknown difficulty '${d.difficulty}'`);
    }

    // Blocks: explicit `blocks:` list wins; otherwise derive from the legacy
    // fields (code lesson = body markdown + a code block, content lesson =
    // a single markdown block).
    let blocks: Block[] | null = null;
    if (Array.isArray(d.blocks) && d.blocks.length > 0) {
      blocks = d.blocks.map((b: any, i: number) => parseBlock(b, i, courseId));
    } else {
      const legacyCode = parseCodeBlock(d);
      if (legacyCode) {
        blocks = [legacyCode, markdownBlock(content)];
      } else if (content.trim().length > 0) {
        blocks = [markdownBlock(content)];
      }
    }
    if (!blocks || blocks.length === 0) {
      throw new Error("lesson has no content: add a body or a `blocks:` list");
    }

    const hasExercise = blocks.some((b) => b.type === "code");

    return {
      id: String(d.id),
      courseId,
      title: String(d.title),
      difficulty: (d.difficulty ?? "easy") as Difficulty,
      order: typeof d.order === "number" ? d.order : Infinity,
      tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
      blocks,
      hasExercise,
    };
  } catch (e) {
    loadErrors[path.basename(file)] = (e as Error).message;
    console.error(`[trucoder] failed to load lesson ${file}:`, (e as Error).message);
    return null;
  }
}

function markdownBlock(content: string): MarkdownBlock {
  return { type: "markdown", content };
}

/** Build a code block from legacy lesson frontmatter (pre-blocks format). */
function parseCodeBlock(d: Record<string, any>): CodeBlock | null {
  const starterMap = normalizeLangMap(d.starter);
  if (Object.keys(starterMap).length === 0 && d.type !== "code") return null;

  const languages: Lang[] = (d.languages ?? []).filter((l: string) =>
    SUPPORTED_LANGS.has(l as Lang)
  );
  if (languages.length === 0) languages.push("java");

  // Module exercises: the learner writes ONE real backend file that a visible
  // node:test suite imports. `module` carries the file map + preview.
  const mode = d.mode === "module" ? "module" : "function";
  const mod = d.module as Record<string, any> | undefined;
  const moduleSpec: ModuleSpec | undefined =
    mode === "module" && mod
      ? {
          entry: String(mod.entry ?? "main.js"),
          language: mod.language === "typescript" ? "typescript" : "javascript",
          testsFile: String(mod.testsFile ?? "lesson.test.js"),
          testsContent: typeof mod.testsContent === "string" ? mod.testsContent : "",
          extraFiles: mod.extraFiles
            ? Object.fromEntries(
                Object.entries(mod.extraFiles as Record<string, unknown>).map(
                  ([k, v]) => [k, String(v)]
                )
              )
            : undefined,
          preview: typeof mod.preview === "string" ? mod.preview : undefined,
        }
      : undefined;

  // Per-language reference solutions (optional). `solution` stays the
  // canonical fallback for lessons that don't split by language.
  const solutions = normalizeLangMap(d.solutions);

  return {
    type: "code",
    task: String(d.task ?? "Implement solve(...) per the signature."),
    languages,
    signature: normalizeLangMap(d.signature),
    starterCode: starterMap,
    publicTests: mapTests(d.tests?.public),
    privateTests: mapTests(d.tests?.private),
    timeLimitMs: typeof d.timeLimitMs === "number" ? d.timeLimitMs : 2000,
    hints: Array.isArray(d.hints) ? d.hints.map(String) : [],
    solution: typeof d.solution === "string" ? d.solution : undefined,
    solutions: Object.keys(solutions).length > 0 ? solutions : undefined,
    mode,
    module: moduleSpec,
  };
}

/** Parse one entry of a `blocks:` list into a typed block. */
function parseBlock(raw: any, index: number, courseId: string): Block {
  if (!raw || typeof raw !== "object") {
    throw new Error(`block #${index}: expected an object with a type`);
  }
  switch (raw.type) {
    case "markdown": {
      if (typeof raw.content !== "string") {
        throw new Error(`block #${index} (markdown): missing content`);
      }
      return { type: "markdown", content: raw.content };
    }
    case "code": {
      const block = parseCodeBlock(raw);
      if (!block) throw new Error(`block #${index} (code): missing starter code`);
      return block;
    }
    case "mcq": {
      if (
        typeof raw.prompt !== "string" ||
        !Array.isArray(raw.options) ||
        raw.options.length < 2 ||
        typeof raw.answer !== "number" ||
        raw.answer < 0 ||
        raw.answer >= raw.options.length
      ) {
        throw new Error(
          `block #${index} (mcq): need prompt, >=2 options, and a valid answer index`
        );
      }
      const b: McqBlock = {
        type: "mcq",
        prompt: raw.prompt,
        options: raw.options.map(String),
        answer: raw.answer,
        explanation: typeof raw.explanation === "string" ? raw.explanation : "",
      };
      return b;
    }
    case "mscq": {
      if (
        typeof raw.prompt !== "string" ||
        !Array.isArray(raw.options) ||
        raw.options.length < 2 ||
        !Array.isArray(raw.answer) ||
        raw.answer.length === 0 ||
        raw.answer.some(
          (a: unknown) =>
            typeof a !== "number" || a < 0 || a >= raw.options.length
        )
      ) {
        throw new Error(
          `block #${index} (mscq): need prompt, >=2 options, and a non-empty answer index list`
        );
      }
      const b: MscqBlock = {
        type: "mscq",
        prompt: raw.prompt,
        options: raw.options.map(String),
        answer: [
          ...new Set((raw.answer as unknown[]).map((a) => Number(a))),
        ].sort((a, b) => a - b),
        explanation: typeof raw.explanation === "string" ? raw.explanation : "",
      };
      return b;
    }
    case "image": {
      if (typeof raw.src !== "string" || typeof raw.alt !== "string") {
        throw new Error(`block #${index} (image): need src and alt`);
      }
      const b: ImageBlock = {
        type: "image",
        src: raw.src,
        alt: raw.alt,
        caption: typeof raw.caption === "string" ? raw.caption : undefined,
      };
      if (!fs.existsSync(path.join(config.coursesDir, courseId, "assets", path.basename(b.src)))) {
        console.warn(
          `[trucoder] image block #${index} in ${courseId}: asset not found: ${b.src}`
        );
      }
      return b;
    }
    case "flowchart": {
      if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
        throw new Error(`block #${index} (flowchart): need a non-empty nodes list`);
      }
      const edges: FlowEdge[] = (raw.edges ?? []).map((e: any, ei: number) => {
        if (
          typeof e !== "object" ||
          typeof e.from !== "number" ||
          typeof e.to !== "number" ||
          e.from < 0 ||
          e.to < 0 ||
          e.from >= raw.nodes.length ||
          e.to >= raw.nodes.length
        ) {
          throw new Error(
            `block #${index} (flowchart): edge #${ei} must have valid from/to node indices`
          );
        }
        return {
          from: e.from,
          to: e.to,
          label: typeof e.label === "string" ? e.label : undefined,
        };
      });
      const b: FlowchartBlock = {
        type: "flowchart",
        title: typeof raw.title === "string" ? raw.title : undefined,
        nodes: raw.nodes.map(String),
        edges,
      };
      return b;
    }
    default:
      throw new Error(
        `block #${index}: unknown block type '${String(raw.type)}' (expected markdown, code, mcq, mscq, image, flowchart)`
      );
  }
}

function normalizeLangMap(
  raw: unknown
): Partial<Record<Lang, string>> {
  const out: Partial<Record<Lang, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (SUPPORTED_LANGS.has(k as Lang) && typeof v === "string") {
      out[k as Lang] = v;
    }
  }
  return out;
}

function loadCourse(dir: string): void {
  const courseFile = path.join(dir, "course.mdx");
  if (!fs.existsSync(courseFile)) {
    console.warn(`[trucoder] skipping ${dir}: no course.mdx`);
    return;
  }
  let data: Record<string, unknown>;
  let body: string;
  try {
    const fm = parseFrontmatter(courseFile);
    data = fm.data;
    body = fm.content;
  } catch (e) {
    loadErrors[path.basename(dir)] = (e as Error).message;
    console.error(`[trucoder] failed to load course ${courseFile}:`, (e as Error).message);
    return;
  }
  const id = String(data.id ?? path.basename(dir));

  // Folder membership: a course joins a folder by id (see folders.json). An
  // unknown id is a content mistake, so log it and keep the course in the root
  // rather than inventing an empty folder.
  let folder: string | null = null;
  if (typeof data.folder === "string" && data.folder.trim()) {
    const wanted = data.folder.trim();
    if (folderIds.has(wanted)) folder = wanted;
    else
      console.warn(
        `[trucoder] course ${id}: unknown folder '${wanted}' (not in ${FOLDERS_FILE}) — keeping it in the root`
      );
  }

  const lessonsDir = path.join(dir, "lessons");
  const lessonFiles = fs.existsSync(lessonsDir)
    ? fs
        .readdirSync(lessonsDir)
        .filter((f) => f.endsWith(".mdx"))
        .sort()
    : [];

  const lessons = lessonFiles
    .map((f) => loadLesson(id, path.join(lessonsDir, f)))
    .filter((l): l is Lesson => l !== null)
    .sort((a, b) => a.order - b.order);

  cache.set(id, {
    id,
    title: String(data.title ?? id),
    description: String(data.description ?? ""),
    difficultyLevels: Array.isArray(data.difficultyLevels)
      ? data.difficultyLevels.map(String)
      : [],
    body,
    lessons,
    folder,
  });

  searchIndex = [...searchIndex, ...lessons.map((l) => ({
    courseId: id,
    courseTitle: String(data.title ?? id),
    folder,
    lessonId: l.id,
    title: l.title,
    words: lessonWords(lessonSearchText(l)),
  }))];
}

export function scanCourses(): void {
  cache = new Map();
  loadErrors = {};
  searchIndex = [];
  if (!fs.existsSync(config.coursesDir)) return;
  // Folders first: course loading validates `folder:` against the registry.
  loadFolders();
  const entries = fs
    .readdirSync(config.coursesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."));
  for (const e of entries) {
    loadCourse(path.join(config.coursesDir, e.name));
  }
  const grouped = [...cache.values()].filter((c) => c.folder).length;
  console.log(
    `[trucoder] loaded ${cache.size} course(s), ${[...cache.values()].reduce(
      (n, c) => n + c.lessons.length,
      0
    )} lesson(s), ${folders.length} folder(s) (${grouped} grouped)`
  );
}

export function getCourses(): Course[] {
  return [...cache.values()];
}

export function getCourse(id: string): Course | undefined {
  return cache.get(id);
}

export function getLesson(courseId: string, lessonId: string): Lesson | undefined {
  return cache.get(courseId)?.lessons.find((l) => l.id === lessonId);
}

export function getLoadErrors(): Record<string, string> {
  return loadErrors;
}

export function getSearchIndex(): SearchEntry[] {
  return searchIndex;
}

let watcher: chokidar.FSWatcher | null = null;

/** Watch the courses tree and re-scan on any change. Call once at startup. */
export function watchCourses(): void {
  if (watcher) return;
  if (!fs.existsSync(config.coursesDir)) return;
  let timer: NodeJS.Timeout | null = null;
  watcher = chokidar.watch(config.coursesDir, { ignoreInitial: true });
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      scanCourses();
    }, 300);
  });
}
