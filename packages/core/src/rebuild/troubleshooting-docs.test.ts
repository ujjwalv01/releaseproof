import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_TS = path.join(here, "run.ts");
const PLAN_TS = path.join(here, "plan.ts");
const TROUBLESHOOTING_DOC = path.join(here, "../../../../docs/troubleshooting.md");

/**
 * Every distinct failure message fragment that `rebuildPackage` (`run.ts`) or `planBuild`
 * (`plan.ts`) can report. Keeping this list in sync with both the code and
 * `docs/troubleshooting.md` ensures new rebuild failure reasons are documented.
 */
export const DOCUMENTED_FAILURE_FRAGMENTS = [
  "timed out",
  "exited with code",
  "could not read the repository inspection",
  "checked out ",
  "was not found in the repository at this commit",
  "several package.json files are named",
  "is marked private",
  "must name an exact version such as",
  "is not supported (only npm, pnpm and yarn are)",
  "bun lockfiles are not supported yet",
  "escapes the package",
  "build stage did not report the tarball digest",
  "does not match the build stage's",
  "unexpected error:",
] as const;

function literalText(expr: ts.Expression): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isTemplateExpression(expr)) {
    return [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)].join("…");
  }
  if (ts.isParenthesizedExpression(expr)) {
    return literalText(expr.expression);
  }
  throw new Error(`Unreadable failure message expression: ${expr.getText()}`);
}

/**
 * Extracts every failure message string or template from `run.ts` (`fail(...)` calls and
 * `stageFailure`) and `plan.ts` (`reason:` and `unsupported:` object properties).
 * Identifier pass-throughs such as `fail(planned.reason)` or `fail(stageFailure(...))`
 * delegate to messages collected at their own definition sites.
 */
export function extractFailureMessages(runSource: string, planSource: string): string[] {
  const messages: string[] = [];

  const runFile = ts.createSourceFile("run.ts", runSource, ts.ScriptTarget.Latest, true);
  function visitRun(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "fail" && node.arguments.length === 1) {
        const arg = node.arguments[0] as ts.Expression;
        // `fail(stageFailure(...))` and `fail(planned.reason)` forward messages collected below.
        const isForwarded =
          (ts.isCallExpression(arg) &&
            ts.isIdentifier(arg.expression) &&
            arg.expression.text === "stageFailure") ||
          (ts.isPropertyAccessExpression(arg) && arg.name.text === "reason");
        if (!isForwarded) {
          messages.push(literalText(arg));
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "stageFailure" &&
      node.body !== undefined
    ) {
      node.body.forEachChild(function visitStageFailure(child) {
        if (ts.isConditionalExpression(child)) {
          messages.push(literalText(child.whenTrue), literalText(child.whenFalse));
        }
        child.forEachChild(visitStageFailure);
      });
    }
    ts.forEachChild(node, visitRun);
  }
  visitRun(runFile);

  const planFile = ts.createSourceFile("plan.ts", planSource, ts.ScriptTarget.Latest, true);
  function visitPlan(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      (node.name.text === "reason" || node.name.text === "unsupported")
    ) {
      const init = node.initializer;
      // `reason: manager.unsupported` forwards the `unsupported:` strings already collected.
      const isForwarded = ts.isPropertyAccessExpression(init) && init.name.text === "unsupported";
      if (!isForwarded) {
        messages.push(literalText(init));
      }
    }
    ts.forEachChild(node, visitPlan);
  }
  visitPlan(planFile);

  return messages;
}

describe("docs/troubleshooting.md", () => {
  const runSource = readFileSync(RUN_TS, "utf8");
  const planSource = readFileSync(PLAN_TS, "utf8");
  const doc = readFileSync(TROUBLESHOOTING_DOC, "utf8");
  const codeMessages = extractFailureMessages(runSource, planSource);

  it("documents every fragment in docs/troubleshooting.md", () => {
    const missingFromDoc = DOCUMENTED_FAILURE_FRAGMENTS.filter(
      (fragment) => !doc.includes(fragment),
    );
    expect(
      missingFromDoc,
      `fragments missing from docs/troubleshooting.md: ${missingFromDoc.join(", ")}`,
    ).toEqual([]);
  });

  it("matches every failure message in run.ts and plan.ts to a documented fragment", () => {
    expect(codeMessages.length).toBeGreaterThanOrEqual(DOCUMENTED_FAILURE_FRAGMENTS.length);
    const unmatched = codeMessages.filter(
      (msg) => !DOCUMENTED_FAILURE_FRAGMENTS.some((fragment) => msg.includes(fragment)),
    );
    expect(
      unmatched,
      `undocumented rebuild failure messages in run.ts / plan.ts: ${unmatched.join(" | ")}`,
    ).toEqual([]);
  });

  it("keeps DOCUMENTED_FAILURE_FRAGMENTS free of stale entries not present in the code", () => {
    const stale = DOCUMENTED_FAILURE_FRAGMENTS.filter(
      (fragment) => !codeMessages.some((msg) => msg.includes(fragment)),
    );
    expect(
      stale,
      `stale fragments in DOCUMENTED_FAILURE_FRAGMENTS not found in run.ts or plan.ts: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("detects when a new failure reason is added to code or a fragment goes stale", () => {
    const extraCode = extractFailureMessages(
      `function f() { return fail("brand new undocumented failure reason"); }`,
      "",
    );
    expect(extraCode).toEqual(["brand new undocumented failure reason"]);
    expect(DOCUMENTED_FAILURE_FRAGMENTS.some((fragment) => extraCode[0]?.includes(fragment))).toBe(
      false,
    );
  });
});
