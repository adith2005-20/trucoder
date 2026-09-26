export type Lang = "java" | "javascript" | "python" | "cpp";
export type Difficulty = "beginner" | "easy" | "medium" | "hard";

export interface TestCase {
  name: string;
  args: unknown[];
  /** Expected result as a compact JSON string (string-safe for big ints). */
  expected: string;
}

/** Module-exercise metadata (mode: "module"). The learner edits ONE real
 *  backend file (`entry`) inside a mini project; the visible node:test file
 *  (`testsFile`) imports it and runs against a real Node server in the
 *  sandbox. Extra (read-only) files ship alongside so the imports resolve. */
export interface ModuleSpec {
  /** The file the learner writes, e.g. "services/cartService.js". */
  entry: string;
  /** "javascript" | "typescript" (Node 24 native type stripping). */
  language: "javascript" | "typescript";
  /** Visible test file (node:test) that imports the entry module. */
  testsFile: string;
  /** The test file's content (node:test source, run in the sandbox). */
  testsContent: string;
  /** Read-only files required by the test/entry (e.g. routes, services). */
  extraFiles?: Record<string, string>;
  /** Canned preview text shown only when ALL tests pass. */
  preview?: string;
}

/** A coding exercise block (the classic TruCoder lesson). */
export interface CodeBlock {
  type: "code";
  task: string;
  languages: Lang[];
  signature: Partial<Record<Lang, string>>;
  starterCode: Partial<Record<Lang, string>>;
  publicTests: TestCase[];
  privateTests: TestCase[];
  timeLimitMs: number;
  hints: string[];
  /** Reference solution — never sent to the client. */
  solution?: string;
  /** Per-language reference solutions; `solution` is the fallback when the
   *  requested language has no entry. Never sent to the client. */
  solutions?: Partial<Record<Lang, string>>;
  /** "function" (default) | "module" — module exercises run real backend
   *  files against a visible node:test suite instead of solve() functions. */
  mode?: "function" | "module";
  /** Present when mode === "module". */
  module?: ModuleSpec;
}

/** Prose block (markdown, callouts, code fences — the reading material). */
export interface MarkdownBlock {
  type: "markdown";
  content: string;
}

/** Single-choice question. `answer` is the index of the correct option. */
export interface McqBlock {
  type: "mcq";
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

/** Multiple-select question. `answer` is the set of correct option indices. */
export interface MscqBlock {
  type: "mscq";
  prompt: string;
  options: string[];
  answer: number[];
  explanation: string;
}

/** Image block — src is relative to `courses/<courseId>/assets/`. */
export interface ImageBlock {
  type: "image";
  src: string;
  alt: string;
  caption?: string;
}

/** Simple DAG flowchart rendered client-side (no external deps). */
export interface FlowEdge {
  from: number;
  to: number;
  label?: string;
}
export interface FlowchartBlock {
  type: "flowchart";
  title?: string;
  nodes: string[];
  edges: FlowEdge[];
}

export type QuizBlock = McqBlock | MscqBlock;
export type Block =
  | CodeBlock
  | MarkdownBlock
  | McqBlock
  | MscqBlock
  | ImageBlock
  | FlowchartBlock;

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  difficulty: Difficulty;
  order: number;
  tags: string[];
  /** Ordered content blocks. A lesson is a sequence of typed blocks. */
  blocks: Block[];
  /** True when at least one block is a coding exercise. */
  hasExercise: boolean;
}

/** A folder groups courses on the index. Folders are pure metadata: a course
 *  joins one by setting `folder: <id>` in its course.mdx frontmatter. Folders
 *  carry no lesson content of their own, and a course without a folder sits in
 *  the root of the index. Definitions live in `courses/folders.json`. */
export interface Folder {
  id: string;
  title: string;
  description: string;
  /** Sort key on the index (lower first); ties fall back to title. */
  order: number;
}

export interface Course {
  id: string;
  title: string;
  description: string;
  difficultyLevels: string[];
  /** Markdown syllabus/welcome body. */
  body: string;
  lessons: Lesson[];
  /** Folder id this course belongs to, or null for a root-level course. */
  folder: string | null;
}
