import { Router } from "express";
import { getCourse, getLesson } from "../courses/loader";
import type { Block, CodeBlock, Lang, QuizBlock } from "../courses/types";
import {
  getProgress,
  getRecentSubmissions,
  getSolvedQuizBlocks,
  markLessonRead,
  recordAnswer,
  recordSubmission,
} from "../db";
import { runPublic, runModule, submit, runCustom } from "../judge";
import { createRateLimiter } from "../rate-limit";

export const lessonsRouter = Router({ mergeParams: true });

// Sandbox runs spawn real containers — cap the churn per user so a learner
// (or a stuck client) can't drive the daemon into the ground.
const judgeLimiter = createRateLimiter(60_000, 15);

function parseBody(body: unknown): { lang: Lang; code: string } | null {
  const b = body as { language?: unknown; code?: unknown };
  if (
    typeof b?.language !== "string" ||
    !["java", "javascript", "python", "cpp"].includes(b.language)
  ) {
    return null;
  }
  if (typeof b?.code !== "string" || b.code.trim().length === 0) return null;
  return { lang: b.language as Lang, code: b.code };
}

function paramsOf(req: {
  params: { courseId?: string; lessonId: string };
}): { courseId: string; lessonId: string } {
  // courseId comes from the parent router via mergeParams.
  return { courseId: req.params.courseId ?? "", lessonId: req.params.lessonId };
}

/** Find the lesson's code block (a lesson has at most one). */
function codeBlockOf(lesson: { blocks: Block[] }): CodeBlock | undefined {
  return lesson.blocks.find((b) => b.type === "code") as CodeBlock | undefined;
}

/** Quiz blocks of a lesson, with their block indices (server-side ids). */
function quizBlocksOf(lesson: { blocks: Block[] }): {
  index: number;
  block: QuizBlock;
}[] {
  return lesson.blocks
    .map((b, i) => ({ index: i, block: b as QuizBlock }))
    .filter(
      (x): x is { index: number; block: QuizBlock } =>
        x.block.type === "mcq" || x.block.type === "mscq"
    );
}

/** Strip server-only fields (answers, solutions) before sending blocks. */
function publicBlocks(lesson: { blocks: Block[] }): unknown[] {
  return lesson.blocks.map((b) => {
    if (b.type === "mcq" || b.type === "mscq") {
      const { answer: _answer, ...rest } = b;
      return rest;
    }
    if (b.type === "code") {
      const { solution: _solution, privateTests: _priv, ...rest } = b;
      return rest;
    }
    return b;
  });
}

/** Full lesson content for learning (public tests visible, private hidden). */
lessonsRouter.get("/:lessonId", (req, res) => {
  const userId = req.userId!;
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  const p = getProgress(userId, lesson.courseId, lesson.id);
  const solvedQuizzes = getSolvedQuizBlocks(userId, lesson.courseId, lesson.id);
  const quizBlocks = quizBlocksOf(lesson);

  // A lesson is solved when its graded blocks are all solved:
  // code block -> accepted submission (progress.solved); quizzes -> correct answers.
  // Content-only lessons are solved ONLY when marked read (POST .../read) —
  // defaulting them to solved made progress meaningless (owner report 2026-08).
  const codeSolved = Boolean(p?.solved);
  const quizSolved = quizBlocks.every((q) => solvedQuizzes.has(q.index));

  // Previous/next lesson within the course (ordered by `order`).
  const ordered = (getCourse(lesson.courseId)?.lessons ?? []).sort(
    (a, b) => a.order - b.order
  );
  const idx = ordered.findIndex((l) => l.id === lesson.id);
  const prevLesson =
    idx > 0
      ? { id: ordered[idx - 1].id, title: ordered[idx - 1].title }
      : null;
  const nextLesson =
    idx >= 0 && idx < ordered.length - 1
      ? { id: ordered[idx + 1].id, title: ordered[idx + 1].title }
      : null;

  res.json({
    id: lesson.id,
    courseId: lesson.courseId,
    title: lesson.title,
    difficulty: lesson.difficulty,
    order: lesson.order,
    tags: lesson.tags,
    hasExercise: lesson.hasExercise,
    blocks: publicBlocks(lesson),
    solvedBlocks: [...solvedQuizzes],
    progress: {
      solved: codeSolved && quizSolved,
      attemptCount: p?.attempt_count ?? 0,
    },
    lastCode: p?.last_code ?? null,
    lastLanguage: (p?.last_language as Lang) ?? null,
    prevLesson,
    nextLesson,
    lessonIndex: idx,
    lessonCount: ordered.length,
  });
});

/** Mark a lesson with no graded blocks as read (no coding exercise). */
lessonsRouter.post("/:lessonId/read", (req, res) => {
  const userId = req.userId!;
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  if (lesson.hasExercise || quizBlocksOf(lesson).length > 0) {
    return res
      .status(400)
      .json({ error: "this lesson has graded content — solve it instead" });
  }
  markLessonRead(userId, courseId, lessonId);
  res.json({ solved: true });
});

/** Grade a quiz block (mcq/mscq) and record the answer. */
lessonsRouter.post("/:lessonId/answer", (req, res) => {
  const userId = req.userId!;
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });

  const body = req.body as { blockId?: unknown; answers?: unknown };
  const blockId = Number(body?.blockId);
  if (!Number.isInteger(blockId) || blockId < 0) {
    return res.status(400).json({ error: "invalid blockId" });
  }
  const target = lesson.blocks[blockId];
  if (!target || (target.type !== "mcq" && target.type !== "mscq")) {
    return res.status(400).json({ error: "block is not a quiz" });
  }
  if (!Array.isArray(body?.answers) || body.answers.length === 0) {
    return res.status(400).json({ error: "invalid answers" });
  }
  // Strict element check BEFORE numeric coercion: Number(null) is 0, so a
  // naive map(Number) would silently grade [null] as option 0.
  const rawAnswers = body.answers as unknown[];
  if (
    !rawAnswers.every(
      (a) =>
        (typeof a === "number" && Number.isInteger(a)) ||
        (typeof a === "string" && /^\d+$/.test(a))
    )
  ) {
    return res.status(400).json({ error: "invalid answer indices" });
  }
  const answers = [...new Set(rawAnswers.map(Number))].sort((a, b) => a - b);
  if (answers.some((a) => a < 0 || a >= target.options.length)) {
    return res.status(400).json({ error: "answer index out of range" });
  }

  let correct: boolean;
  if (target.type === "mcq") {
    correct = answers.length === 1 && answers[0] === target.answer;
  } else {
    const want = [...target.answer].sort((a, b) => a - b);
    correct =
      answers.length === want.length &&
      answers.every((a, i) => a === want[i]);
  }

  recordAnswer(
    userId,
    lesson.courseId,
    lesson.id,
    blockId,
    correct,
    JSON.stringify(answers)
  );

  // A quiz-only lesson is complete when every quiz block is answered correctly.
  const solvedQuizzes = getSolvedQuizBlocks(userId, lesson.courseId, lesson.id);
  const quizSolved = quizBlocksOf(lesson).every((q) => solvedQuizzes.has(q.index));
  const lessonSolved = !lesson.hasExercise && quizSolved;
  if (lessonSolved) markLessonRead(userId, lesson.courseId, lesson.id);

  res.json({
    correct,
    explanation: correct ? target.explanation : "",
    lessonSolved,
  });
});

/**
 * Parse { args: "JSON array text", expected: "text" } for a custom test.
 * args must parse as a JSON array; both are length-capped so a client cannot
 * push a multi-MB stdin blob through the sandbox.
 */
function parseCustomTestBody(
  body: unknown
): { args: unknown[]; expected: string } | null {
  const b = body as { args?: unknown; expected?: unknown };
  if (typeof b?.args !== "string" || typeof b?.expected !== "string") {
    return null;
  }
  if (b.args.length > 65536 || b.expected.length > 65536) return null;
  let args: unknown;
  try {
    args = JSON.parse(b.args);
  } catch {
    return null;
  }
  if (!Array.isArray(args)) return null;
  return { args, expected: b.expected };
}

/** Run ONE user-supplied custom test (their args + their expected output)
 *  against their code. Not persisted — like run, it is feedback only. */
lessonsRouter.post("/:lessonId/custom-test", async (req, res) => {
  const rl = judgeLimiter.check(`u${req.userId}`);
  if (!rl.allowed) {
    return res
      .status(429)
      .set("Retry-After", String(rl.retryAfterSecs))
      .json({ error: `too many runs — try again in ${rl.retryAfterSecs}s` });
  }
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  const block = codeBlockOf(lesson);
  if (!block) {
    return res.status(400).json({ error: "this lesson has no coding exercise" });
  }
  if (block.mode === "module") {
    return res
      .status(400)
      .json({ error: "custom tests need a solve() exercise, not a module" });
  }
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: "invalid body" });
  if (!block.signature[body.lang] || !block.starterCode[body.lang]) {
    return res.status(400).json({ error: `lesson does not support ${body.lang}` });
  }
  const custom = parseCustomTestBody(req.body);
  if (!custom) {
    return res.status(400).json({
      error: "custom test needs args as a JSON array and an expected value",
    });
  }
  try {
    const result = await runCustom(
      block,
      body.lang,
      body.code,
      custom.args,
      custom.expected
    );
    if (result.sandboxError) {
      return res.status(503).json({ error: result.sandboxError });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Run the visible public tests (fast feedback while coding). */
lessonsRouter.post("/:lessonId/run", async (req, res) => {
  const rl = judgeLimiter.check(`u${req.userId}`);
  if (!rl.allowed) {
    return res
      .status(429)
      .set("Retry-After", String(rl.retryAfterSecs))
      .json({ error: `too many runs — try again in ${rl.retryAfterSecs}s` });
  }
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  const block = codeBlockOf(lesson);
  if (!block) {
    return res.status(400).json({ error: "this lesson has no coding exercise" });
  }
  const raw = req.body as { language?: unknown; code?: unknown };
  if (block.mode === "module") {
    const spec = block.module;
    if (!spec) return res.status(400).json({ error: "module spec missing" });
    if (raw.language !== spec.language || typeof raw.code !== "string") {
      return res.status(400).json({ error: "invalid body" });
    }
    try {
      const result = await runModule(block, raw.code);
      if (result.sandboxError) {
        return res.status(503).json({ error: result.sandboxError });
      }
      return res.json({
        module: true,
        publicTests: result.results,
        output: result.output,
        compileError: result.compileError,
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: "invalid body" });
  if (!block.signature[body.lang] || !block.starterCode[body.lang]) {
    return res.status(400).json({ error: `lesson does not support ${body.lang}` });
  }
  try {
    const result = await runPublic(block, body.lang, body.code);
    if (result.sandboxError) {
      return res.status(503).json({ error: result.sandboxError });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Final grading: public + hidden tests, then persist progress. */
lessonsRouter.post("/:lessonId/submit", async (req, res) => {
  const rl = judgeLimiter.check(`u${req.userId}`);
  if (!rl.allowed) {
    return res
      .status(429)
      .set("Retry-After", String(rl.retryAfterSecs))
      .json({ error: `too many submissions — try again in ${rl.retryAfterSecs}s` });
  }
  const userId = req.userId!;
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  const block = codeBlockOf(lesson);
  if (!block) {
    return res.status(400).json({ error: "this lesson has no coding exercise" });
  }
  const raw = req.body as { language?: unknown; code?: unknown };
  if (block.mode === "module") {
    const spec = block.module;
    if (!spec) return res.status(400).json({ error: "module spec missing" });
    if (raw.language !== spec.language || typeof raw.code !== "string") {
      return res.status(400).json({ error: "invalid body" });
    }
    try {
      const result = await runModule(block, raw.code);
      if (result.sandboxError) {
        return res.status(503).json({ error: result.sandboxError });
      }
      const passed = result.results.filter((r) => r.passed).length;
      const total = result.results.length;
      const verdict = total > 0 && passed === total ? "accepted" : "wrong";
      recordSubmission({
        userId,
        courseId: lesson.courseId,
        lessonId: lesson.id,
        language: String(raw.language),
        code: raw.code,
        verdict,
        publicPassed: passed,
        publicTotal: total,
        privatePassed: 0,
        privateTotal: 0,
        compileError: result.compileError,
      });
      return res.json({
        module: true,
        verdict,
        publicTests: result.results,
        output: result.output,
        privatePassed: 0,
        privateTotal: 0,
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  }
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: "invalid body" });
  if (!block.signature[body.lang] || !block.starterCode[body.lang]) {
    return res.status(400).json({ error: `lesson does not support ${body.lang}` });
  }
  try {
    const result = await submit(block, body.lang, body.code);
    if (result.sandboxError) {
      // Infrastructure failure — not a valid attempt; do not record it.
      return res.status(503).json({ error: result.sandboxError });
    }
    recordSubmission({
      userId,
      courseId: lesson.courseId,
      lessonId: lesson.id,
      language: body.lang,
      code: body.code,
      verdict: result.verdict,
      publicPassed: result.publicTests.filter((t) => t.passed).length,
      publicTotal: result.publicTests.length,
      privatePassed: result.privatePassed,
      privateTotal: result.privateTotal,
      compileError: result.compileError,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Reveal a code block's reference solution on demand (Show Solution). */
lessonsRouter.post("/:lessonId/solution", async (req, res) => {
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  const block = codeBlockOf(lesson);
  if (!block) return res.status(404).json({ error: "no solution available" });
  const body = parseBody(req.body);
  const lang = body?.lang ?? "javascript";
  // Per-language solution when the lesson provides one; the canonical
  // `solution` string is the fallback for single-solution lessons.
  const solution = block.solutions?.[lang as Lang] ?? block.solution;
  if (!solution) {
    return res.status(404).json({ error: "no solution available" });
  }
  res.json({
    solution,
    lang,
    module: block.mode === "module" ? true : false,
  });
});

/** Attempt history for a lesson (verdicts + code of the last submissions). */
lessonsRouter.get("/:lessonId/submissions", (req, res) => {
  const userId = req.userId!;
  const { courseId, lessonId } = paramsOf(req);
  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return res.status(404).json({ error: "lesson not found" });
  const rows = getRecentSubmissions(userId, courseId, lessonId);
  res.json({
    submissions: rows.map((r) => ({
      id: r.id,
      verdict: r.verdict,
      language: r.language,
      code: r.code,
      publicPassed: r.public_passed,
      publicTotal: r.public_total,
      privatePassed: r.private_passed,
      privateTotal: r.private_total,
      createdAt: r.created_at,
    })),
  });
});
