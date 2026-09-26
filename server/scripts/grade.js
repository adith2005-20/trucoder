// Grade one lesson's reference solutions through the REAL judge (all
// languages), one language at a time. This is the fast authoring loop:
//
//   cd server && ./node_modules/.bin/tsc
//   SANDBOX_URL=http://127.0.0.1:9000 SANDBOX_NODE_URL=http://127.0.0.1:9001 \
//     node scripts/grade.js <courseId> [lessonId ...]
//
// Omit lesson ids to grade a whole course. Every language the lesson ships a
// reference solution for is graded on its own (canonical `solution` runs as
// python, each `solutions.<lang>` entry runs in that language) — exactly what
// verify.js does for the whole corpus, scoped to one lesson so an authoring
// agent can iterate in seconds instead of minutes.
//
// On the host, point SANDBOX_URL at the published loopback ports
// (127.0.0.1:9000 / 127.0.0.1:9001) — the default `http://sandbox:9000`
// hostname only resolves inside the compose network.
process.env.DATA_DIR = "/tmp/trucoder-grade-data";
const { scanCourses, getCourse, getLesson } = require("../dist/courses/loader");
const { submit, runModule } = require("../dist/judge");

const [courseId, ...lessonIds] = process.argv.slice(2);
if (!courseId) {
  console.error("usage: node scripts/grade.js <courseId> [lessonId ...]");
  process.exit(2);
}

scanCourses();
const course = getCourse(courseId);
if (!course) {
  console.error(`course not found: ${courseId}`);
  process.exit(2);
}

const targets = lessonIds.length
  ? lessonIds.map((id) => ({ id, lesson: getLesson(courseId, id) }))
  : course.lessons.map((l) => ({ id: l.id, lesson: l }));

let fail = 0;
let graded = 0;
let skipped = 0;

(async () => {
  for (const { id, lesson } of targets) {
    if (!lesson) {
      console.log(`FAIL ${id} (no such lesson)`);
      fail += 1;
      continue;
    }
    const codeBlocks = lesson.blocks.filter((b) => b.type === "code");
    if (codeBlocks.length === 0) {
      skipped += 1;
      console.log(`SKIP ${id} (no code block)`);
      continue;
    }
    const block = codeBlocks[0];
    if (block.mode === "module") {
      graded += 1;
      const res = await runModule(block, block.solution);
      const passed = res.results.filter((r) => r.passed).length;
      const total = res.results.length;
      if (total > 0 && passed === total) {
        console.log(`PASS ${id} [module] (${passed}/${total} tests)`);
      } else {
        fail += 1;
        console.log(`FAIL ${id} [module] (${passed}/${total} tests)`);
        const bad = res.results.find((r) => !r.passed);
        if (bad) console.log(`  ${bad.error || `expected ${bad.expected} got ${bad.actual}`}`);
      }
      continue;
    }
    const sols = Object.entries(block.solutions ?? {}).filter(([, code]) => code);
    const runs = [
      ...(block.solution ? [{ lang: "python", code: block.solution }] : []),
      ...sols
        .filter(([lang, code]) => !(lang === "python" && code === block.solution))
        .map(([lang, code]) => ({ lang, code })),
    ];
    if (runs.length === 0) {
      fail += 1;
      console.log(`FAIL ${id} (no reference solution)`);
      continue;
    }
    for (const { lang, code } of runs) {
      graded += 1;
      const res = await submit(block, lang, code);
      const total = res.publicTests.length + res.privateTotal;
      if (res.verdict === "accepted") {
        console.log(`PASS ${id} [${lang}] (${res.publicTests.length} public + ${res.privateTotal} private)`);
        continue;
      }
      fail += 1;
      console.log(`FAIL ${id} [${lang}] verdict=${res.verdict} (${total} tests)`);
      if (res.compileError) console.log(`  compile: ${res.compileError.split("\n").slice(0, 4).join(" | ")}`);
      if (res.error && !res.compileError) console.log(`  error: ${res.error.split("\n")[0]}`);
      for (const t of res.publicTests.filter((t) => !t.passed)) {
        console.log(`  public test "${t.name}": expected ${t.expected} got ${t.actual ?? t.error}`);
      }
      // Private tests are count-only in the judge result (learners must not see
      // them). For an authoring loop, re-run each failing private test as a
      // one-test batch so the expected/actual pair is visible.
      if (res.privatePassed < res.privateTotal) {
        for (const t of block.privateTests) {
          const one = { ...block, publicTests: [t], privateTests: [] };
          const r = await submit(one, lang, code);
          const row = r.publicTests[0];
          if (row && !row.passed) {
            console.log(`  private test "${t.name}": expected ${row.expected} got ${row.actual ?? row.error}`);
          }
        }
      }
    }
  }
  console.log(`\n==== ${graded} graded, ${skipped} skipped, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
