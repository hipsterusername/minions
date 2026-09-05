import { openProjectFixture } from "./project-fixture.mjs";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

async function expectCommandPopoverAbove(prompt, menu, viewportHeight) {
  await expect(menu).toBeVisible();
  await expect(prompt.getByRole("listbox", { name: "Leader context shortcuts" })).toHaveCount(0);
  const [promptBounds, menuBounds] = await Promise.all([
    prompt.boundingBox(),
    menu.boundingBox(),
  ]);
  expect(promptBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds.y + menuBounds.height).toBeLessThan(promptBounds.y);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewportHeight);
}

test("keeps New Leader configuration and popovers contained", async ({ page }) => {
  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/, (route) =>
    route.abort(),
  );
  await openProjectFixture(page, "Activity Launch");

  const addAgent = page.getByRole("region", { name: "Add an agent" });
  await expect(addAgent).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 520 });
  const emptyPrompt = addAgent.locator(".leader-launch-prompt");
  await addAgent.getByLabel("Leader prompt", { exact: true }).fill("/");
  const emptyCommandMenu = page.getByRole("listbox", { name: "Leader context shortcuts" });
  await expectCommandPopoverAbove(emptyPrompt, emptyCommandMenu, 520);
  await page.keyboard.press("Escape");
  await expect(emptyCommandMenu).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 900 });
  await addAgent.getByLabel("Leader prompt", { exact: true }).fill(
    "Create a small baseline session for the Activity launch test.",
  );
  await addAgent.getByRole("button", { name: "Launch leader" }).click();
  const newLeader = page.getByRole("button", { name: "New", exact: true });
  await expect(newLeader).toBeEnabled();

  await newLeader.click();
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

  // Run setup can legitimately scroll as settings and skills grow. Verify the
  // controls remain reachable instead of pinning which nested panel scrolls.
  const lastSetting = settings.getByRole("checkbox").last();
  await lastSetting.scrollIntoViewIfNeeded();
  await expect(lastSetting).toBeInViewport();

  const prompt = launchPanel.locator(".leader-launch-prompt");
  await launchPanel.getByLabel("Leader prompt", { exact: true }).fill("/");
  const commandMenu = page.getByRole("listbox", { name: "Leader context shortcuts" });
  await expectCommandPopoverAbove(prompt, commandMenu, 900);
  await page.keyboard.press("Escape");
  await expect(commandMenu).toBeHidden();

  await launchPanel.getByLabel("Leader prompt", { exact: true }).fill(
    "Create a contained Activity launch experience.",
  );
  await expect(launchPanel.getByRole("button", { name: "Launch leader" })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 720 });
  const launch = launchPanel.getByRole("button", { name: "Launch leader" });
  await launch.scrollIntoViewIfNeeded();
  await expect(launch).toBeInViewport();
  await expect(launch).toBeEnabled();
  await lastSetting.scrollIntoViewIfNeeded();
  await expect(lastSetting).toBeInViewport();

  await page.setViewportSize({ width: 1440, height: 520 });
  await launchPanel.getByLabel("Leader prompt", { exact: true }).fill("/");
  const shortCommandMenu = page.getByRole("listbox", { name: "Leader context shortcuts" });
  await expectCommandPopoverAbove(prompt, shortCommandMenu, 520);
});
