// Verify every course: run each code block's reference solution against all
// its public + private tests, and sanity-check quiz blocks. A lesson is green
// only if its tests match its solution.
process.env.DATA_DIR = "/tmp/trucoder-verify-data";
const { scanCourses, getCourses } = require("../dist/courses/loader");
const { submit, runModule, runCustom, customTestOutcome } = require("../dist/judge");

// Pure self-check of the custom-test comparison (no sandbox needed).
// `[1, 2]` must match the driver's compact `[1,2]`; bare `hello` must match
// the quoted `"hello"`; a number `5` must NOT match the string `"5"`.
function verifyCustomTestOutcome() {
  const cases = [
    ["[1, 2]", "[1,2]", true],
    ["hello", '"hello"', true],
    ["5", '"5"', false],
    ["7", "7", true],
    [" 7 ", "7", true],
  ];
  for (const [expected, actual, want] of cases) {
    const r = customTestOutcome(expected, actual);
    if (r.passed !== want) {
      throw new Error(
        `customTestOutcome(${JSON.stringify(expected)}, ${JSON.stringify(actual)}) -> ${r.passed}, want ${want}`
      );
    }
  }
}
verifyCustomTestOutcome();

// Validate a lesson's quiz blocks: answer indices must be in range and
// unique, mscq answers must be non-empty index sets, options must have at
// least 2 entries. Returns a list of human-readable problems.
function validateQuizBlocks(blocks) {
  const problems = [];
  for (const b of blocks) {
    if (b.type !== "mcq" && b.type !== "mscq") continue;
    if (!Array.isArray(b.options) || b.options.length < 2) {
      problems.push(`${b.type}: options must have at least 2 entries`);
      continue;
    }
    if (b.type === "mcq") {
      if (!Number.isInteger(b.answer) || b.answer < 0 || b.answer >= b.options.length) {
        problems.push(
          `mcq: answer ${JSON.stringify(b.answer)} out of range for ${b.options.length} options`
        );
      }
    } else {
      if (!Array.isArray(b.answer) || b.answer.length === 0) {
        problems.push("mscq: answer must be a non-empty array of indices");
      } else {
        const bad = b.answer.filter(
          (i) => !Number.isInteger(i) || i < 0 || i >= b.options.length
        );
        if (bad.length) {
          problems.push(
            `mscq: answer indices [${bad.join(", ")}] out of range for ${b.options.length} options`
          );
        }
        if (new Set(b.answer).size !== b.answer.length) {
          problems.push("mscq: duplicate answer indices");
        }
      }
    }
  }
  return problems;
}

(async () => {
  scanCourses();
  let pass = 0;
  let fail = 0;
  for (const course of getCourses()) {
    console.log(`\n== ${course.title} ==`);
    for (const lesson of course.lessons) {
      const codeBlocks = lesson.blocks.filter((b) => b.type === "code");
      if (codeBlocks.length > 1) {
        console.log(`  FAIL ${lesson.id} (${codeBlocks.length} code blocks — at most 1 allowed)`);
        fail += 1;
        continue;
      }
      const codeBlock = codeBlocks[0];
      if (!codeBlock) {
        // No code exercise: validate quiz blocks instead.
        const quizzes = lesson.blocks.filter(
          (b) => b.type === "mcq" || b.type === "mscq"
        );
        if (quizzes.length) {
          const problems = validateQuizBlocks(quizzes);
          if (problems.length) {
            console.log(`  FAIL ${lesson.id}`);
            for (const p of problems) console.log(`    ${p}`);
            fail += 1;
          } else {
            pass += 1;
            console.log(`  PASS ${lesson.id} (${quizzes.length} quiz block(s) validated)`);
          }
        } else {
          console.log(`  SKIP ${lesson.id} (content)`);
        }
        continue;
      }
      if (!codeBlock.solution) {
        console.log(`  SKIP ${lesson.id} (code block has no reference solution)`);
        fail += 1;
        continue;
      }
      if (codeBlock.mode === "module") {
        const spec = codeBlock.module;
        if (
          !spec ||
          !spec.entry ||
          !spec.testsFile ||
          !spec.testsContent ||
          !codeBlock.starterCode[spec.language]
        ) {
          console.log(
            `  FAIL ${lesson.id} (module spec incomplete: entry/testsFile/testsContent/starter required)`
          );
          fail += 1;
          continue;
        }
        const res = await runModule(codeBlock, codeBlock.solution);
        if (res.sandboxError) {
          fail += 1;
          console.log(`  FAIL ${lesson.id} sandbox: ${res.sandboxError}`);
          continue;
        }
        const passed = res.results.filter((r) => r.passed).length;
        const total = res.results.length;
        if (total > 0 && passed === total) {
          pass += 1;
          console.log(`  PASS ${lesson.id} (module, ${passed}/${total} tests)`);
        } else {
          fail += 1;
          console.log(`  FAIL ${lesson.id} (module, ${passed}/${total} tests)`);
          const bad = res.results.find((t) => !t.passed);
          if (bad) {
            console.log(
              "    " + (bad.error || `expected ${bad.expected} got ${bad.actual}`)
            );
          }
        }
        continue;
      }
      // Verify the canonical `solution` (as python, historical behavior) PLUS
      // every per-language `solutions` entry in its own language, so a
      // Java/C++/JS-only regression in a multi-language lesson cannot sail
      // through CI. A `solutions.python` entry identical to the canonical
      // solution is skipped (already covered by the python run).
      const toVerify = [
        codeBlock.solution ? { lang: "python", code: codeBlock.solution } : null,
        ...Object.entries(codeBlock.solutions ?? {})
          .filter(
            ([lang, code]) =>
              !(lang === "python" && code === codeBlock.solution)
          )
          .map(([lang, code]) => ({ lang, code })),
      ].filter((v) => v && v.code);
      let verifiedAny = false;
      for (const v of toVerify) {
        verifiedAny = true;
        const res = await submit(codeBlock, v.lang, v.code);
        if (res.verdict === "accepted") {
          pass += 1;
          console.log(
            `  PASS ${lesson.id} [${v.lang}] (${res.publicTests.length} pub + ${res.privateTotal} priv)`
          );
        } else {
          fail += 1;
          console.log(`  FAIL ${lesson.id} [${v.lang}] verdict=${res.verdict}`);
          const bad =
            res.publicTests.find((t) => t.error) ??
            res.publicTests.find((t) => !t.passed);
          if (bad) {
            console.log(
              "    " + (bad.error || `expected ${bad.expected} got ${bad.actual}`)
            );
          }
        }
      }
      if (!verifiedAny) {
        fail += 1;
        console.log(`  FAIL ${lesson.id} (no verifiable solution text)`);
      }
      // Custom-test path: the same solution must also pass a user-supplied
      // test (first public test, run through the new /custom-test pipeline).
      const first = codeBlock.publicTests[0];
      if (first && toVerify.length > 0) {
        const v = toVerify[0];
        const custom = await runCustom(
          codeBlock,
          v.lang,
          v.code,
          first.args,
          first.expected
        );
        if (custom.sandboxError) {
          fail += 1;
          console.log(`  FAIL ${lesson.id} custom-test sandbox: ${custom.sandboxError}`);
        } else if (!custom.passed) {
          fail += 1;
          console.log(
            `  FAIL ${lesson.id} custom-test expected ${custom.expected} got ${custom.actual}`
          );
        }
      }
    }
  }
  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
