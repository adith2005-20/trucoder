import { runInSandbox, runModuleInSandbox, type SandboxResult } from "./sandbox";
import { TRU_SENTINEL } from "./util/harness";
import type { CodeBlock, Lang, TestCase } from "./courses/types";
import type {
  ModuleRunResult,
  RunResult,
  SubmitResult,
  TestResult,
} from "./types";

/**
 * Grading pipeline:
 *
 *   user code + lesson  ->  harness (calls solve, one JSON result per line)
 *   all test cases      ->  one container execution, stdin = { tests: [...] }
 *   results             ->  line i == result for test i, compared to expected
 *
 * Batching all tests into a single container run means one javac compile and
 * one container per action, instead of one per test case. The runner is
 * swappable per-lesson in the future; today every lesson uses the default
 * "call solve and compare JSON" runner.
 */

const ERROR_MARKER = "__tru_error__";

function resultFromLine(line: string, test: TestCase): TestResult {
  const trimmed = line.trim();
  if (trimmed.startsWith(`{"${ERROR_MARKER}"`)) {
    let message = trimmed;
    try {
      const obj = JSON.parse(trimmed);
      message = String(obj[ERROR_MARKER] ?? trimmed);
    } catch {
      /* keep raw */
    }
    return {
      name: test.name,
      passed: false,
      error: `runtime error: ${message.slice(0, 2000)}`,
    };
  }
  return {
    name: test.name,
    passed: trimmed === test.expected,
    expected: test.expected,
    actual: trimmed || "(no output)",
  };
}

/** Extract the driver's per-test result lines. The drivers prefix every
 *  result with the @TRU@ sentinel; anything else on stdout is the learner's
 *  own output (debug prints) and must not shift results out of alignment. */
function parseResults(stdout: string, tests: TestCase[]): TestResult[] {
  const results: TestResult[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(TRU_SENTINEL)) continue;
    results.push(resultFromLine(line.slice(TRU_SENTINEL.length).trim(), tests[results.length] ?? { name: "test", args: [], expected: "" }));
  }
  return tests.map((t, i) =>
    results[i] ?? { name: t.name, passed: false, error: "(no output for this test)" }
  );
}

function compileErrorFrom(lang: Lang, res: SandboxResult): string | undefined {
  // Compilers (java, cpp) exit 2 on compile failure; interpreters don't compile.
  return (lang === "java" || lang === "cpp") && res.code === 2 ? res.stderr : undefined;
}

async function runBatch(
  block: CodeBlock,
  lang: Lang,
  code: string,
  tests: TestCase[]
): Promise<{ results: TestResult[]; sandboxError?: string }> {
  // The per-test budget is per test case, but the batch runs every test in
  // one process under a single wall-clock timeout. Scale the budget with the
  // number of tests (a 2s-per-test lesson with 10 tests gets 20s, not 2s) and
  // cap it so one lesson cannot hog the sandbox daemon.
  const perTestMs = block.timeLimitMs || 2000;
  const batchMs = Math.min(perTestMs * Math.max(tests.length, 1), 20_000);
  try {
    const res = await runInSandbox({
      language: lang,
      code,
      tests: tests.map((t) => ({ args: t.args })),
      timeLimitMs: batchMs,
    });
    // Infrastructure failure (docker/image/daemon) — not the learner's fault.
    if (res.sandboxError) {
      return { results: [], sandboxError: res.sandboxError };
    }
    if (compileErrorFrom(lang, res)) {
      return {
        results: tests.map((t) => ({
          name: t.name,
          passed: false,
          error: `compile error:\n${compileErrorFrom(lang, res)!.slice(0, 2000)}`,
        })),
      };
    }
    if (res.timedOut) {
      return {
        results: tests.map((t) => ({
          name: t.name,
          passed: false,
          error:
            "time limit exceeded — your code was too slow for the hidden tests. Look for a faster approach (e.g. memoization).",
        })),
      };
    }
    if (res.code !== 0) {
      return {
        results: tests.map((t) => ({
          name: t.name,
          passed: false,
          error: `runtime error (exit ${res.code}):\n${(res.stderr || "").slice(
            0,
            2000
          )}`,
        })),
      };
    }
    return { results: parseResults(res.stdout, tests) };
  } catch (err) {
    return {
      results: tests.map((t) => ({
        name: t.name,
        passed: false,
        error: `runner error: ${(err as Error).message}`,
      })),
    };
  }
}

export async function runPublic(
  block: CodeBlock,
  lang: Lang,
  code: string
): Promise<import("./types").RunResult> {
  const { results, sandboxError } = await runBatch(
    block,
    lang,
    code,
    block.publicTests
  );
  if (sandboxError) return { publicTests: [], sandboxError };
  const compileError = results.find((r) => r.error?.startsWith("compile error"))
    ?.error;
  return { publicTests: results, compileError };
}

export async function submit(
  block: CodeBlock,
  lang: Lang,
  code: string
): Promise<import("./types").SubmitResult> {
  const all = [...block.publicTests, ...block.privateTests];
  const { results, sandboxError } = await runBatch(block, lang, code, all);
  if (sandboxError) {
    return {
      verdict: "error",
      publicTests: [],
      privatePassed: 0,
      privateTotal: block.privateTests.length,
      sandboxError,
    };
  }

  const publicTests = results.slice(0, block.publicTests.length);
  const privateTests = results.slice(block.publicTests.length);
  const privatePassed = privateTests.filter((r) => r.passed).length;

  const compileError = publicTests.find((r) =>
    r.error?.startsWith("compile error")
  )?.error;
  const runtimeError = publicTests.find((r) =>
    r.error?.startsWith("runtime error")
  )?.error;
  const timedOut = results.some((r) =>
    r.error?.startsWith("time limit exceeded")
  );

  const publicPassed = publicTests.filter((r) => r.passed).length;
  const allPassed =
    compileError === undefined &&
    runtimeError === undefined &&
    !timedOut &&
    publicPassed === publicTests.length &&
    privatePassed === privateTests.length;

  return {
    verdict: compileError
      ? "error"
      : timedOut
        ? "timeout"
        : runtimeError
          ? "error"
          : allPassed
            ? "accepted"
            : "wrong",
    publicTests,
    privatePassed,
    privateTotal: privateTests.length,
    compileError,
    error: compileError || runtimeError || (timedOut ? "time limit exceeded" : undefined),
  };
}

/**
 * Forgiving comparison for a user-typed expected value against the driver's
 * actual output line:
 *  - valid JSON is re-serialized compactly, so `[1, 2]` matches `[1,2]`;
 *  - bare non-JSON text also matches its quoted form, so `hello` matches
 *    `"hello"` (the driver JSON-encodes every result).
 * A numeric `5` never matches the string `"5"` — the bare fallback only
 * applies when the input is NOT valid JSON.
 */
export function customTestOutcome(
  expectedRaw: string,
  actual: string
): { expected: string; passed: boolean } {
  const trimmed = expectedRaw.trim();
  let normalized: string;
  let bare: string | undefined;
  try {
    normalized = JSON.stringify(JSON.parse(trimmed));
  } catch {
    normalized = trimmed;
    bare = JSON.stringify(trimmed);
  }
  return {
    expected: normalized,
    passed: actual === normalized || (bare !== undefined && actual === bare),
  };
}

/** Run ONE user-supplied custom test (their args + their expected output). */
export async function runCustom(
  block: CodeBlock,
  lang: Lang,
  code: string,
  args: unknown[],
  expected: string
): Promise<import("./types").CustomTestResult> {
  const outcome = customTestOutcome(expected, ""); // dummy actual: we only need the normalized `expected`
  const { results, sandboxError } = await runBatch(block, lang, code, [
    { name: "custom test", args, expected: outcome.expected },
  ]);
  if (sandboxError) return { passed: false, sandboxError };
  const r = results[0];
  if (!r) return { passed: false, error: "no result from runner" };
  if (r.error) return { passed: false, error: r.error };
  const actual = r.actual ?? "";
  return { ...customTestOutcome(expected, actual), actual };
}

/** Compact rendering of an assert actual/expected value for the UI. */
function fmtAssert(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

/**
 * Parse node:test JSON-reporter NDJSON (one event object per line) into
 * per-test verdicts. The file-level event (name === testsFile path) and
 * suite events are skipped; each test() maps to one TestResult with
 * expected/actual extracted from the assertion error when available.
 */
function parseModuleResults(stdout: string, testsFile: string): TestResult[] {
  const results: TestResult[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const data = ev.data ?? {};
    const name = String(data.name ?? "test");
    // Skip the file-level event (the suite itself) — only test() entries.
    if (name === testsFile || name.endsWith(`/${testsFile}`)) continue;
    const details = data.details ?? {};
    if (details.type === "suite") continue;

    if (ev.type === "test:pass") {
      results.push({ name, passed: true });
      continue;
    }
    const err = details.error;
    let message = "";
    let actual: string | undefined;
    let expected: string | undefined;
    if (err && typeof err === "object") {
      message = String(err.message ?? "");
      if (err.actual !== undefined) actual = fmtAssert(err.actual);
      if (err.expected !== undefined) expected = fmtAssert(err.expected);
    } else if (err !== undefined) {
      message = String(err);
    }
    if (!message && details.failureType === "testCodeFailure") {
      message = "assertion failed";
    }
    results.push({
      name,
      passed: false,
      expected,
      actual,
      error: message ? `assert: ${message}` : "test failed",
    });
  }
  return results;
}

/** Run a module exercise: real backend file + visible node:test suite. */
export async function runModule(
  block: CodeBlock,
  code: string
): Promise<ModuleRunResult> {
  const spec = block.module;
  if (!spec) return { results: [], sandboxError: "module spec missing" };
  // The test file is mounted under tests/ so its `../services/...` requires
  // resolve against the project layout (same as the offline project repo).
  const testPath = `tests/${spec.testsFile}`;
  const files: Record<string, string> = {
    [spec.entry]: code,
    [testPath]: spec.testsContent,
  };
  for (const [p, c] of Object.entries(spec.extraFiles ?? {})) files[p] = c;
  try {
    const res = await runModuleInSandbox({
      files,
      entry: spec.entry,
      testsFile: testPath,
      timeLimitMs: block.timeLimitMs,
    });
    if (res.sandboxError) return { results: [], sandboxError: res.sandboxError };
    if (res.timedOut) {
      return {
        results: [
          {
            name: "test suite",
            passed: false,
            error: "time limit exceeded — the suite did not finish in time.",
          },
        ],
        output: res.stdout,
      };
    }
    const results = parseModuleResults(res.stdout, spec.testsFile);
    if (results.length === 0 && res.code !== 0) {
      // Fatal load/runtime failure (e.g. TS type error, missing import).
      const detail = (res.stderr || res.stdout || "").slice(0, 2000);
      return {
        results: [
          {
            name: "test suite",
            passed: false,
            error: `runtime error (exit ${res.code}):\n${detail}`,
          },
        ],
        output: res.stdout,
      };
    }
    // Output preview = the test file's own stdout; strip the reporter NDJSON
    // lines that run.sh cats to stdout alongside it.
    const output = res.stdout
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("{") && t.includes('"type":"test:'));
      })
      .join("\n");
    return { results, output };
  } catch (err) {
    return {
      results: [
        {
          name: "test suite",
          passed: false,
          error: `runner error: ${(err as Error).message}`,
        },
      ],
    };
  }
}
