import { expect, test } from "@playwright/test";
import { openResponsiveFixture } from "./responsive-fixture.mjs";

const bottomGap = (feed) => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);

test('Activity opens at latest, preserves history while streaming, and resumes following', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await openResponsiveFixture(page);
  await page.locator('.act-session-home__open').click();
  const feed = page.getByRole('region', { name: 'Conversation messages' });
  await expect(feed).toContainText('Verify controls, keyboard access, and scrolling at smaller sizes.');
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  await feed.evaluate(el => { el.scrollTop = 100; });
  const jump = page.getByRole('button', { name: /Jump to latest/ });
  await expect(jump).toBeVisible();
  fixture.send({ type: 'sdk_event', sessionKey: 'layout-0', event: { kind: 'text', role: 'assistant', text: 'A newly arrived response.' } });
  await expect(feed).toContainText('A newly arrived response.');
  await expect.poll(() => feed.evaluate(el => el.scrollTop)).toBe(100);
  await expect(jump).toHaveText('New activity · Jump to latest');
  await jump.click();
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  await expect(feed).toBeFocused();
  await expect(jump).toBeHidden();

  // Late media/layout growth follows the latest message without a new event.
  await feed.locator('.act-conversation').evaluate(el => {
    const content = document.createElement('div'); content.style.height = '300px'; el.append(content);
  });
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  await feed.evaluate(el => { el.scrollTop = 100; });
  await expect(jump).toBeVisible();
  await page.getByRole('button', { name: 'Context Needs you', exact: true }).click();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect.poll(() => feed.evaluate(el => el.scrollTop)).toBe(100);
  await jump.click();
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('fullscreen keeps conversation spacious and panels dismissible, then returns to Activity', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openResponsiveFixture(page);
  await page.locator('.act-session-home__open').click();
  await page.getByRole('button', { name: 'Add to canvas', exact: true }).click();
  await page.getByRole('tab', { name: /^Activity(?: \d+)?$/ }).click();
  await page.locator('.act-session-home__open').click();
  await page.getByRole('button', { name: 'Expand fullscreen', exact: true }).click();
  const overlay = page.getByRole('dialog', { name: 'Leader fullscreen cockpit' });
  const feed = overlay.getByRole('region', { name: 'Conversation messages' });
  await expect(feed).toContainText('Verify controls, keyboard access, and scrolling at smaller sizes.');
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  const execution = overlay.getByRole('button', { name: 'Toggle execution panel' });
  const context = overlay.getByRole('button', { name: 'Toggle context panel' });
  await expect(execution).toHaveAttribute('aria-expanded', 'false');
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  expect((await feed.boundingBox()).width).toBeGreaterThan(1000);
  await context.click();
  await expect(overlay.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await overlay.getByRole('button', { name: 'Close context panel' }).click();
  await expect(context).toBeFocused();

  await feed.evaluate(el => { el.scrollTop = 100; });
  await overlay.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect.poll(() => bottomGap(feed)).toBeLessThan(2);
  for (const width of [1100, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await execution.click();
    await expect(execution).toHaveAttribute('aria-expanded', 'true');
    await overlay.getByRole('button', { name: 'Close execution panel' }).press('Escape');
    await expect(execution).toHaveAttribute('aria-expanded', 'false');
    await expect(execution).toBeFocused();
    await expect(overlay).toBeVisible();
    await context.click();
    await overlay.getByRole('button', { name: 'Dismiss side panel' }).click({ position: { x: 1, y: 300 } });
    await expect(context).toHaveAttribute('aria-expanded', 'false');
    expect(await overlay.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await overlay.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Reply or steer this agent' })).toBeVisible();
  expect(errors).toEqual([]);
});
