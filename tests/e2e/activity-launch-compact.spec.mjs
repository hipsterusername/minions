import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

test("keeps New Leader configuration and popovers contained", async ({ page }) => {
  const baseProjectPath = process.env.MINIONS_E2E_PROJECT;
  if (!baseProjectPath) throw new Error("MINIONS_E2E_PROJECT is required");
  const projectPath = `${baseProjectPath}-activity-launch`;

  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByPlaceholder("/path/to/new/project...").fill(projectPath);
  await page
    .getByPlaceholder("Project name (optional, defaults to folder name)")
    .fill("Activity Launch");
  await page.getByRole("button", { name: "Create" }).click();

  const addAgent = page.getByRole("region", { name: "Add an agent" });
  await expect(addAgent).toBeVisible();
  await addAgent.getByRole("textbox", { name: "Leader prompt" }).fill(
    "Create a small baseline session for the Activity launch test.",
  );
  await addAgent.getByRole("button", { name: "Launch leader" }).click();
  await expect(page.getByRole("button", { name: "Launch leader" })).toBeEnabled();

  await page.getByRole("button", { name: "Launch leader" }).click();
  const launchPanel = page.getByRole("region", { name: "New leader" });
  await expect(launchPanel).toBeVisible();

  const settings = launchPanel.getByRole("complementary", { name: "Run setup" });
  await expect(settings.getByText("Run configuration")).toBeVisible();
  await expect(settings.locator("details")).toHaveCount(0);
  await expect(settings.getByLabel("Configured settings")).toContainText(/shared/i);
  await expect(settings.getByRole("combobox", { name: "Model" })).toBeVisible();
  await expect(settings.getByRole("checkbox", { name: "Isolated worktree" })).toBeVisible();
  await expect(settings.getByText("Skills", { exact: true })).toBeVisible();
  await settings.getByRole("checkbox", { name: /System Model Authoring/i }).click();
  await expect(settings.getByLabel("Configured settings")).toContainText(/1 skill/i);

  const geometry = await launchPanel.evaluate((panel) => {
    const inputs = panel.querySelector(".act-launch-inputs");
    const card = panel.querySelector(".leader-launch-primary");
    const config = panel.querySelector(".leader-launch-config");
    const prompt = panel.querySelector(".leader-launch-prompt");
    const textarea = panel.querySelector('textarea[aria-label="Leader prompt"]');
    if (
      !(inputs instanceof HTMLElement)
      || !(card instanceof HTMLElement)
      || !(config instanceof HTMLElement)
      || !(prompt instanceof HTMLElement)
      || !(textarea instanceof HTMLTextAreaElement)
    ) return null;
    const bounds = card.getBoundingClientRect();
    const promptBounds = prompt.getBoundingClientRect();
    const textareaBounds = textarea.getBoundingClientRect();
    return {
      panelScrolls: panel.scrollHeight > panel.clientHeight,
      inputsScroll: inputs.scrollHeight > inputs.clientHeight,
      configScrolls: config.scrollHeight > config.clientHeight,
      cardTop: bounds.top,
      cardBottom: bounds.bottom,
      promptHeight: promptBounds.height,
      textareaHeight: textareaBounds.height,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry.panelScrolls).toBe(false);
  expect(geometry.inputsScroll).toBe(false);
  expect(geometry.configScrolls).toBe(false);
  expect(geometry.cardTop).toBeGreaterThanOrEqual(0);
  expect(geometry.cardBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.promptHeight).toBeGreaterThan(240);
  expect(geometry.textareaHeight).toBeGreaterThan(200);

  const prompt = launchPanel.locator(".leader-launch-prompt");
  await launchPanel.getByRole("textbox", { name: "Leader prompt" }).fill("/");
  const commandMenu = launchPanel.getByRole("listbox", { name: "Leader context shortcuts" });
  await expect(commandMenu).toBeVisible();
  const menuGeometry = await prompt.evaluate((container) => {
    const menu = container.querySelector('[role="listbox"]');
    if (!(menu instanceof HTMLElement)) return null;
    const containerBounds = container.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    return {
      containerTop: containerBounds.top,
      containerBottom: containerBounds.bottom,
      menuTop: menuBounds.top,
      menuBottom: menuBounds.bottom,
    };
  });
  expect(menuGeometry).not.toBeNull();
  expect(menuGeometry.menuTop).toBeGreaterThanOrEqual(menuGeometry.containerTop);
  expect(menuGeometry.menuBottom).toBeLessThanOrEqual(menuGeometry.containerBottom);

  await launchPanel.getByRole("textbox", { name: "Leader prompt" }).fill(
    "Create a contained Activity launch experience.",
  );
  await expect(launchPanel.getByRole("button", { name: "Launch leader" })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 720 });
  const shortViewport = await launchPanel.evaluate((panel) => {
    const inputs = panel.querySelector(".act-launch-inputs");
    const card = panel.querySelector(".leader-launch-primary");
    const config = panel.querySelector(".leader-launch-config");
    if (
      !(inputs instanceof HTMLElement)
      || !(card instanceof HTMLElement)
      || !(config instanceof HTMLElement)
    ) return null;
    const bounds = card.getBoundingClientRect();
    return {
      inputsScroll: inputs.scrollHeight > inputs.clientHeight,
      configScrolls: config.scrollHeight > config.clientHeight,
      cardTop: bounds.top,
      cardBottom: bounds.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(shortViewport).not.toBeNull();
  expect(shortViewport.inputsScroll).toBe(false);
  expect(typeof shortViewport.configScrolls).toBe("boolean");
  expect(shortViewport.cardTop).toBeGreaterThanOrEqual(0);
  expect(shortViewport.cardBottom).toBeLessThanOrEqual(shortViewport.viewportHeight);
});
