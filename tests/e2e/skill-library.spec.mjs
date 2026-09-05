import { openProjectFixture } from "./project-fixture.mjs";
import { expect, test } from "@playwright/test";

test("creates a themed skill, explores its context, launches and reloads it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProjectFixture(page, "Skill Library Journey");
  await page.getByRole("tab", { name: "Canvas" }).click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const panel = page.locator('[data-dock-panel="skills"]');
  await panel.getByRole("button", { name: "New skill" }).click();
  const editor = page.getByRole("dialog", { name: "New Skill" });
  await editor.getByLabel("Name *", { exact: true }).fill("Release Scout");
  await editor.getByLabel("Description", { exact: true }).fill("Review release readiness and deployment risks.");
  await editor.getByLabel("Template *", { exact: true }).fill("Review {{target}} before release. Check tests and rollback steps.");
  await editor.getByRole("button", { name: /Appearance/ }).click();
  await editor.getByRole("searchbox", { name: "Search icons" }).fill("rocket");
  await editor.getByRole("button", { name: "Rocket", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Rocket", exact: true })).toHaveAttribute("aria-pressed", "true");
  const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/skills") && response.ok());
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  // The editor can dismiss the dock via the existing outside-click behavior.
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Skills", exact: true }).click();
  await panel.getByRole("searchbox", { name: "Search skills" }).fill("Release Scout");
  await panel.getByRole("button", { name: "View Release Scout" }).click();
  await expect(panel.locator('svg[data-minions-icon="rocket"]')).toBeVisible();
  await expect(panel.getByText("Review {{target}} before release. Check tests and rollback steps.")).not.toBeVisible();
  await panel.getByText("Instructions", { exact: true }).click();
  await expect(panel.getByText("Review {{target}} before release. Check tests and rollback steps.")).toBeVisible();
  await panel.locator("summary").filter({ hasText: /^Inputs\b/ }).click();
  await expect(panel.getByText("Target", { exact: true })).toBeVisible();
  const launchSaved = page.waitForResponse((response) =>
    response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith("/state") && response.ok());
  await panel.getByRole("button", { name: "Launch with Release Scout" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: "Configure skills, 1 active" }).click();
  await expect(page.getByRole("dialog", { name: "Skills", exact: true })
    .getByLabel("Selected skills", { exact: true })).toContainText("Release Scout");
  await launchSaved;
  await page.reload();
  await page.getByText("Skill Library Journey", { exact: true }).click();
  await page.getByRole("tab", { name: "Canvas" }).click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await panel.getByRole("button", { name: "View Release Scout" }).click();
  await panel.getByRole("button", { name: "More actions for Release Scout" }).click();
  await page.getByRole("menuitem", { name: "Edit skill" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Skill" });
  await edit.getByRole("button", { name: /Appearance/ }).click();
  await expect(edit.getByRole("button", { name: "Rocket", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});
