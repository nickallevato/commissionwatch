import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import axe, { type AxeResults, type Result, type RunOptions } from "axe-core";
import { expect } from "vitest";
import { AllProviders } from "./AllProviders";

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export { render } from "@testing-library/react";
export { screen, waitFor } from "@testing-library/react";

/**
 * Render an axe violation the way a person can act on it: the rule that fired,
 * the plain-language problem, and the actual markup of every node it hit.
 * axe's own `results` object is a deep tree, and a bare `expect(violations)
 * .toEqual([])` prints a screenful of nested objects with the one useful line
 * buried in it.
 */
function describeViolation(violation: Result): string {
  const nodes = violation.nodes
    .map((node) => `      ${node.html}\n        ${node.failureSummary ?? ""}`)
    .join("\n");
  return `  [${violation.id}] ${violation.help}\n    ${violation.helpUrl}\n${nodes}`;
}

/**
 * Assert that a rendered tree has no axe-core accessibility violations.
 *
 * Built straight on `axe-core` rather than on the `vitest-axe` /`jest-axe`
 * matcher wrappers. `vitest-axe` was tried first and its runtime is fine, but
 * its type augmentation targets the global `Vi` namespace that Vitest 2
 * removed, so `expect(...).toHaveNoViolations()` does not typecheck and the
 * only ways to land it are a cast or a `@ts-ignore`. Neither is allowed here,
 * and axe-core's own API is fully typed, so the wrapper bought nothing.
 *
 * Deliberately no rule-disable list. If a rule fires, either the markup is
 * wrong or the finding is a jsdom artefact worth naming in the calling test —
 * a blanket exclusion here would quietly cover both.
 *
 * @param container the element to scan, normally `renderWithProviders(...).container`
 * @param options   per-call axe options, for the rare test that must narrow scope
 */
export async function expectNoA11yViolations(
  container: Element,
  // Defaulted rather than optional: axe.run's overloads treat a second
  // argument of `undefined` as a missing callback, not as "no options".
  options: RunOptions = {},
): Promise<void> {
  const results: AxeResults = await axe.run(container, options);

  expect(
    results.violations.map(describeViolation).join("\n\n"),
    "axe-core found accessibility violations",
  ).toBe("");
}
