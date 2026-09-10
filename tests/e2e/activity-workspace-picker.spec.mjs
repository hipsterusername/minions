import { expect, test } from "@playwright/test";
import { openProjectFixture } from "./project-fixture.mjs";

test("chooses a workspace with context and preserves the draft across navigation", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProjectFixture(page, "Activity Workspace Picker");
  await page.getByRole("textbox", { name: "Leader prompt", exact: true }).fill("Prepare the next release");
  await page.getByRole("tab", { name: "Canvas" }).click();
  const longName = "Research and development for the autumn release";
  for (const name of ["Release", "Design", longName]) {
    const toggle = page.getByRole("button", { name: /^Workspaces ·/ });
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    await page.getByRole("textbox", { name: "Workspace name" }).fill(name);
    await page.getByRole("button", { name: "Save workspace" }).click();
  }
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("region", { name: "Leader draft" }).getByRole("button", { name: "Resume draft" }).click();
  const trigger = page.getByRole("button", { name: "Workspace Global", exact: true });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Launch in workspace" });
  await expect(picker.getByRole("button", { name: `Choose ${longName}` })).toContainText("Current canvas");
  await expect(picker.getByRole("button", { name: "Choose Global", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("activity-workspace-picker-desktop.png") });

  const search = picker.getByRole("searchbox", { name: "Find workspace" });
  await search.fill("missing");
  await expect(picker.getByRole("status")).toContainText("No workspaces found");
  await picker.getByRole("button", { name: "Clear search" }).click();
  await search.fill("release");
  await search.press("ArrowDown");
  await expect(picker.getByRole("button", { name: "Choose Release", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const selected = page.getByRole("button", { name: "Workspace Release", exact: true });
  await expect(selected).toBeFocused();
  await expect(picker).toHaveCount(0);
  await selected.click();
  await page.keyboard.press("Escape");
  await expect(selected).toBeFocused();

  for (const viewport of [{ width: 900, height: 650 }, { width: 1440, height: 520 }]) {
    await page.setViewportSize(viewport);
    await selected.click();
    await expect(picker).toBeVisible();
    const bounds = await picker.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`activity-workspace-picker-${viewport.width}x${viewport.height}.png`) });
    await page.keyboard.press("Escape");
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await selected.click();
  await page.getByRole("tab", { name: "Canvas" }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Workspaces · ${longName}`, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("region", { name: "Leader draft" }).getByRole("button", { name: "Resume draft" }).click();
  await expect(selected).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Leader prompt", exact: true })).toHaveValue("Prepare the next release");
  expect(errors).toEqual([]);
});
