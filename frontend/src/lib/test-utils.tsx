import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { AllProviders } from "./AllProviders";

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export { render } from "@testing-library/react";
export { screen, waitFor } from "@testing-library/react";
