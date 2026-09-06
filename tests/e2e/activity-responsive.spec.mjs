import { expect, test } from "@playwright/test";
import { openResponsiveFixture } from "./responsive-fixture.mjs";

const sizes = [
  [1920, 1080], [1440, 900], [1366, 768], [1280, 800], [1100, 700],
  [1024, 768], [900, 700], [768, 1024], [390, 844], [320, 568], [1366, 520],
];
const pageErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openResponsiveFixture(page);
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function expectContained(locator, width, height) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const bounds = await locator.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1);
}

test("keeps conversation, supporting context, and navigation usable across sizes", async ({ page }) => {
  await page.locator('.act-session-home__open').click();
  const conversation = page.getByRole('main', { name: 'Conversation' });
  const context = page.getByRole('region', { name: 'Leader context' });
  const draft = page.getByRole('textbox', { name: 'Reply or steer this agent' });
  await draft.fill('Keep this reply while changing panels.');

  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await expectContained(conversation, width, height);
    expect((await conversation.boundingBox()).width).toBeGreaterThanOrEqual(Math.min(640, width));
    await expect(draft).toHaveValue('Keep this reply while changing panels.');
    await expectContained(draft, width, height);

    const contextToggle = page.getByRole('button', { name: 'Context Needs you', exact: true });
    if (await contextToggle.isVisible()) {
      await expect(context).toBeHidden();
      const transcript = page.locator('.act-conversation-scroll');
      await transcript.evaluate((element) => { element.scrollTop = 80; });
      const scrollTop = await transcript.evaluate((element) => element.scrollTop);
      await contextToggle.click();
      await expectContained(context, width, height);
      await expect(conversation).toBeHidden();
      const details = context.getByRole('tab', { name: 'Session details', exact: true });
      await details.click();
      await expect(context.getByText('Context and output', { exact: true })).toBeVisible();
      await details.press('Escape');
      await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toBeFocused();
      await expect(draft).toHaveValue('Keep this reply while changing panels.');
      expect(await transcript.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    } else {
      await expect(context).toBeVisible();
    }

    // Truncation must stay inside the header's flex item, never cover view tabs.
    const project = await page.locator('.project-switcher__trigger').boundingBox();
    const tabs = await page.getByRole('tablist', { name: 'View mode' }).boundingBox();
    expect(project.x + project.width).toBeLessThanOrEqual(tabs.x + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const categories = page.locator('.act-summary');
    if (await categories.isVisible()) {
      const tops = await categories.locator('button').evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().top));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
      const collapse = page.getByRole('button', { name: 'Hide activity list', exact: true });
      await expectContained(collapse, width, height);
      const collapseBounds = await collapse.boundingBox();
      const categoryBounds = await categories.boundingBox();
      expect(collapseBounds.x + collapseBounds.width).toBeLessThanOrEqual(categoryBounds.x);
      await categories.locator('button').last().focus();
      await categories.locator('button').last().scrollIntoViewIfNeeded();
      const lastBounds = await categories.locator('button').last().boundingBox();
      expect(lastBounds.x + lastBounds.width).toBeLessThanOrEqual(categoryBounds.x + categoryBounds.width + 1);
    }
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: 'Hide activity list', exact: true }).click();
  await expect(page.locator('.act-main')).toBeHidden();
  await page.getByRole('button', { name: 'Show activity list', exact: true }).click();
  await expect(page.locator('.act-main')).toBeVisible();
  await expect(draft).toHaveValue('Keep this reply while changing panels.');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.act-main')).toBeHidden();
  await page.getByRole('button', { name: 'Back to activity' }).click();
  await expect(page.locator('.act-main')).toBeVisible();
});

test("keeps Launch visible while prompt and all settings remain reachable", async ({ page }) => {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const panel = page.getByRole('region', { name: 'New leader' });
  const prompt = panel.getByLabel('Leader prompt', { exact: true });
  const launch = panel.getByRole('button', { name: 'Launch leader', exact: true });
  await prompt.fill('Review the responsive application layout.');
  await expect(launch).toBeEnabled();

  for (const [width, height] of [...sizes, [1366, 650]]) {
    await page.setViewportSize({ width, height });
    await expectContained(launch, width, height);
    const settings = panel.getByRole('complementary', { name: 'Run setup' });
    const lastSetting = settings.getByRole('checkbox').last();
    await lastSetting.scrollIntoViewIfNeeded();
    await expect(lastSetting).toBeInViewport();
    await expectContained(launch, width, height);
    await prompt.scrollIntoViewIfNeeded();
    await expect(prompt).toBeInViewport();
    await expect(prompt).toHaveValue('Review the responsive application layout.');
    await expectContained(launch, width, height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  await page.setViewportSize({ width: 1366, height: 520 });
  await prompt.fill('/');
  const menu = page.getByRole('listbox', { name: 'Leader context shortcuts' });
  await expectContained(menu, 1366, 520);
  await prompt.press('Escape');
  await expect(menu).toBeHidden();
});
