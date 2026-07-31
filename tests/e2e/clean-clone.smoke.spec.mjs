import { expect, test } from "@playwright/test";

test("creates, launches, persists, and reloads an echo-backed project", async ({ page }) => {
  const projectPath = process.env.MINIONS_E2E_PROJECT;
  if (!projectPath) throw new Error("MINIONS_E2E_PROJECT is required");

  // Keep the credential-free smoke lane independent of external font
  // delivery; late font swaps can prevent Playwright's stability check from
  // settling even though the control is already visible.
  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/new/project...").fill(projectPath);
  await page
    .getByPlaceholder("Project name (optional, defaults to folder name)")
    .fill("Smoke Project");

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/projects" &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create" }).click();
  const created = await (await createdResponse).json();
  expect(created.settings.defaultLeaderHarness).toBe("echo");

  await page.getByRole("tab", { name: "Canvas" }).click();
  await expect(page.getByRole("form", { name: "Start canvas with context" })).toBeVisible();
  const context = "Characterize the clean-clone smoke journey without external credentials.";
  await page.getByLabel("Context description").fill(context);

  const autosaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.endsWith("/state") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Start Leader" }).click();
  await expect(page.getByLabel("Enter fullscreen")).toBeVisible();
  await expect(page.getByText("Ready for review", { exact: true })).toBeVisible();
  await autosaved;

  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.getByText("Smoke Project", { exact: true }).click();
  await page.getByRole("tab", { name: "Canvas" }).click();
  await expect(page.getByLabel("Enter fullscreen")).toBeVisible();
  await page.getByLabel("Enter fullscreen").click();
  await expect(page.getByRole("dialog", { name: "Leader fullscreen cockpit" })).toContainText(
    context,
  );
});
