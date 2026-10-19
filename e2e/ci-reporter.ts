/**
 * Reporter for CI on a runner that holds the 5etools data (E2E_NO_ARTIFACTS=1). It prints only the test title,
 * its status and its duration. Never error messages, stacks, DOM snapshots, call logs or response bodies: they
 * can hold rules text, and the job log is stored by GitHub. For a failure it prints file:line and the title;
 * rerun the test locally to see why.
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class CiReporter implements Reporter {
  private counts: Record<string, number> = {};

  onTestEnd(test: TestCase, result: TestResult) {
    const status = result.status;
    this.counts[status] = (this.counts[status] ?? 0) + 1;
    const where = `${test.location.file.replace(/^.*[\\/]/, '')}:${test.location.line}`;
    const line = status === 'passed' ? `ok     ${test.title}` : `${status.toUpperCase()}  ${where}  ${test.title}`;
    console.log(`${line} (${result.duration} ms)`);
  }

  onEnd(result: FullResult) {
    const summary = Object.entries(this.counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    console.log(`\n${result.status}: ${summary || 'no tests'}`);
    if (result.status !== 'passed') console.log('Details are withheld in CI (rules text). Rerun the failing test locally: pnpm e2e.');
  }

  printsToStdio() {
    return true;
  }
}
