import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

// Feature journeys need their own project, not another copy of the onboarding
// journey. The smoke spec owns UI creation and explicit Git confirmation.
export async function openProjectFixture(page, name) {
  const basePath = process.env.MINIONS_E2E_PROJECT;
  if (!basePath) throw new Error("MINIONS_E2E_PROJECT is required");
  const auth = await page.request.get("/api/auth/token");
  expect(auth.ok()).toBe(true);
  const { token } = await auth.json();
  const response = await page.request.post("/api/projects", {
    headers: { Authorization: `Bearer ${token}` },
    data: { path: `${basePath}-${randomUUID()}`, name, gitAction: "initialize" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const project = await response.json();
  await page.goto("/");
  await page.getByText(name, { exact: true }).click();
  return project;
}
