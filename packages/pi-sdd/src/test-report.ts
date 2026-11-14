export interface TestCategoryResult {
 category: string;
 command: string;
 exitCode: number | null;
 passed: number;
 failed: number;
 skipped: number;
 logPath: string;
 blockedReason: string | null;
}
/** Every supplied category is required; optional categories need separate policy. */
export function suitePassed(results: TestCategoryResult[]): boolean {
 return results.length > 0 && results.every(r =>
  r.exitCode === 0 && r.failed === 0 && r.blockedReason === null &&
  r.category.trim().length > 0 && r.command.trim().length > 0 && r.logPath.trim().length > 0 &&
  [r.passed,r.failed,r.skipped].every(n => Number.isSafeInteger(n) && n >= 0) &&
  !(r.passed === 0 && r.skipped > 0)
 );
}
