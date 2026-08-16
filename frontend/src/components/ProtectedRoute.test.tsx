import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ProtectedRoute } from "./ProtectedRoute";
import { AuthProvider } from "../contexts/AuthContext";
import { server } from "@/mocks/server";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderGuarded() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <p>Console contents</p>
              </ProtectedRoute>
            }
          />
          <Route path="/admin/login" element={<p>Sign-in form</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("ProtectedRoute", () => {
  it("redirects to the login page when the session probe comes back 401", async () => {
    // The default handler answers 401, which is what the real API returns
    // with no cookie.
    renderGuarded();
    await waitFor(() => {
      expect(screen.getByText("Sign-in form")).toBeInTheDocument();
    });
    expect(screen.queryByText("Console contents")).toBeNull();
  });

  it("renders its children once the probe returns an operator", async () => {
    server.use(
      http.get("/api/admin/session", () =>
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

    renderGuarded();
    await waitFor(() => {
      expect(screen.getByText("Console contents")).toBeInTheDocument();
    });
  });

  it("does not bounce to the login page while the probe is still in flight", () => {
    // Redirecting before the probe resolves would throw a signed-in operator
    // back to the form on every page reload.
    renderGuarded();
    expect(screen.getByRole("status")).toHaveTextContent("Checking session");
    expect(screen.queryByText("Sign-in form")).toBeNull();
  });
});
