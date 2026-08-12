/** Shared API result types. Lesson/Course model lives in courses/types.ts. */

export interface TestResult {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  error?: string;
}

export interface RunResult {
  publicTests: TestResult[];
  compileError?: string;
  /** Infrastructure failure (docker/image/daemon) — not the learner's fault. */
  sandboxError?: string;
}

/** Result of a module exercise run (real backend file + visible node:test). */
export interface ModuleRunResult {
  results: TestResult[];
  /** The test file's stdout — shown as the output preview. */
  output?: string;
  compileError?: string;
  sandboxError?: string;
}

/** Result of a single user-supplied custom test (their args + expected). */
export interface CustomTestResult {
  passed: boolean;
  /** Compact-JSON-normalized expected value the code was compared against. */
  expected?: string;
  /** The value solve() actually returned (compact JSON). */
  actual?: string;
  error?: string;
  /** Infrastructure failure (docker/image/daemon) — not the learner's fault. */
  sandboxError?: string;
}

export interface SubmitResult {
  verdict: "accepted" | "wrong" | "error" | "timeout";
  publicTests: TestResult[];
  privatePassed: number;
  privateTotal: number;
  compileError?: string;
  error?: string;
  /** Infrastructure failure (docker/image/daemon) — not the learner's fault. */
  sandboxError?: string;
}
