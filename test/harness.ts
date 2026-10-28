// test/harness.ts
// A tiny zero-dependency test harness so `npm test` runs under tsx without a framework.
//
// Test bodies may be synchronous or async. run() awaits each one in registration order,
// so an async body's assertions really execute and a rejected promise counts as a FAIL.

type TestFn = () => void | Promise<void>;
interface Case {
  name: string;
  fn: TestFn;
  skip?: string; // why the case is not run: the decision it waits on
}

const cases: Case[] = [];
let currentSuite = "";

export function suite(name: string) {
  currentSuite = name;
}

export function test(name: string, fn: TestFn) {
  cases.push({ name: `${currentSuite} > ${name}`, fn });
}

// A case that waits on a decision. It is listed, with the decision, on every run and never run,
// so it cannot pass by accident; delete the skip once the decision is taken.
export function skip(name: string, decision: string, fn: TestFn) {
  cases.push({ name: `${currentSuite} > ${name}`, fn, skip: decision });
}

export function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

export function assertThrows(fn: () => void, message: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`Assertion failed (expected throw): ${message}`);
}

export async function run(): Promise<number> {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.skip) {
      skipped++;
      console.log(`  SKIP  ${c.name}`);
      console.log(`        waiting on: ${c.skip.replace(/\n/g, "\n        ")}`);
      continue;
    }
    try {
      await c.fn();
      passed++;
      console.log(`  PASS  ${c.name}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL  ${c.name}`);
      console.log(`        ${message.replace(/\n/g, "\n        ")}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, ${cases.length} total`);
  return failed;
}
