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

  const gitStatusResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/projects/git-status" &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Create" }).click();
  expect(await (await gitStatusResponse).json()).toEqual({ isRepository: false });

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/projects" &&
      response.status() === 201,
  );
  await page
    .getByRole("button", { name: "Initialize Git & create first commit" })
    .click();
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
  const cockpit = page.getByRole("dialog", { name: "Leader fullscreen cockpit" });
  await expect(cockpit).toContainText(context);

  // Exercise the rendered prompt, including its stylesheet. Searching the TSX
  // for a token name cannot tell us whether the user can read the action.
  await cockpit.getByRole("textbox").fill("Review the saved project.");
  const submit = cockpit.getByRole("button", { name: "New iteration", exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toBeVisible();
  await expect.poll(() => submit.evaluate((button) => {
    const style = getComputedStyle(button);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    function rgba(color) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    }
    function luminance(channels) {
      const linear = channels.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    const foreground = rgba(style.color);
    const background = rgba(style.backgroundColor);
    // These are solid colors; fail explicitly if compositing becomes necessary.
    if (foreground[3] !== 255 || background[3] !== 255 || style.backgroundImage !== "none") {
      throw new Error("Prompt contrast measurement requires solid foreground and background colors");
    }
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    return (values[1] + 0.05) / (values[0] + 0.05);
  }), { message: "Enabled prompt action text contrast after its color transition" })
    .toBeGreaterThanOrEqual(4.5);
});
