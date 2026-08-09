import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LoginPage } from "./LoginPage";
import { AuthProvider } from "../contexts/AuthContext";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderLogin() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/admin/login"]}>
        <Routes>
          <Route path="/admin/login" element={<LoginPage />} />
          <Route path="/admin" element={<p>Operator console</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("LoginPage", () => {
  it("renders the sign-in form", () => {
    renderLogin();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("offers no way to register — there is no public sign-up by policy", () => {
    const { container } = renderLogin();
    expect(container.textContent ?? "").not.toMatch(/register/i);
    expect(container.textContent ?? "").not.toMatch(/create an account/i);
  });

  it("renders the SSO buttons disabled and tagged Soon", () => {
    renderLogin();
    for (const provider of ["Google", "GitHub"]) {
      const button = screen.getByRole("button", { name: new RegExp(`Continue with ${provider}`) });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Soon");
    }
  });

  it("signs in and navigates to the console", async () => {
    server.use(
      http.post("/api/admin/session", () =>
        HttpResponse.json({
          operator: {
            id: "op-1",
            email: "operator@example.invalid",
            name: "Test Operator",
            role: "operator",
            last_login_at: null,
          },
        }),
      ),
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "operator@example.invalid");
    await userEvent.type(screen.getByLabelText("Password"), "a-long-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Operator console")).toBeInTheDocument();
    });
  });

  it("shows one indistinct error on a rejected sign-in, and stays put", async () => {
    // The API answers every failure identically so it cannot be used to
    // enumerate operator addresses. The UI must not invent a distinction.
    server.use(
      http.post("/api/admin/session", () =>
        HttpResponse.json({ error: "Invalid credentials", statusCode: 401 }, { status: 401 }),
      ),
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "operator@example.invalid");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Those credentials were not accepted.");
    expect(screen.queryByText("Operator console")).toBeNull();
    expect(alert.textContent ?? "").not.toMatch(/no such|unknown|locked/i);
  });
});
