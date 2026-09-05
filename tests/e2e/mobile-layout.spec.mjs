import { expect, test } from '@playwright/test';

test.use({ isMobile: true, hasTouch: true });

// Deliberately exercise real layout with deterministic data, without launching
// agents or changing a user's projects through the development server.
const project = { id: 'mobile-layout', path: '/workspace/mobile-layout', name: 'Mobile layout workspace', hasSidecar: true, lastOpened: '2026-09-05T00:00:00Z' };
const sessions = [
  { sessionKey: 'layout-running', sessionId: null, role: 'leader', cwd: project.path, status: 'running', taskName: 'Improve mobile layouts and usability', model: 'gpt-6', totalCost: 1.24 },
  { sessionKey: 'layout-waiting', sessionId: null, role: 'leader', cwd: project.path, status: 'waiting', taskName: 'Review authentication changes', totalCost: 0.82 },
];

async function openWorkspace(page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/auth/token') ? { token: 'layout-test' }
      : path === '/api/projects' ? [project]
      : path === '/api/readiness' ? { harnesses: [] }
      : path.includes('skills') ? [] : {};
    return route.fulfill({ json });
  });
  await page.routeWebSocket('**/ws*', socket => socket.onMessage(raw => {
    const message = JSON.parse(raw);
    if (message.type === 'list_sessions') socket.send(JSON.stringify({ topic: 'global', type: 'session_list', sessions }));
    if (message.type === 'list_harnesses') socket.send(JSON.stringify({ topic: 'global', type: 'harness_list', harnesses: [] }));
  }));
  await page.goto('/m');
  await page.getByRole('button', { name: /Mobile layout workspace/ }).click();
  await expect(page.getByRole('button', { name: /Improve mobile layouts and usability/ })).toBeVisible();
}

async function expectContained(page) {
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.mob-app, .mob-screen, .mob-chat, .mob-tabbar, .mob-app-header')]
    .filter(el => el.scrollWidth > el.clientWidth + 1)
    .map(el => el.className));
  expect(overflow).toEqual([]);
  const nav = await page.getByRole('navigation', { name: 'Mobile navigation' }).boundingBox();
  expect(nav.y + nav.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
}

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
  test(`mobile screens stay usable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await openWorkspace(page);
    await expectContained(page);
    // Selection is optional, and exiting it clears the bulk action state.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select Improve mobile layouts and usability' }).check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: /Improve mobile layouts and usability/ }).click();
    await expect(page.getByRole('combobox', { name: 'Switch session' })).toBeVisible();
    await expect(page.locator('.mob-chat > .mob-session-switcher')).toHaveCount(0);
    await expectContained(page);
    const feed = await page.locator('.mob-chat-feed').boundingBox();
    expect(feed.height).toBeGreaterThan(70);
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await nav.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Review the mobile navigation.');
    await expectContained(page);
    await page.locator('.mob-launch-options > summary').click();
    await expectContained(page);
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Loading settings...')).toBeHidden();
    await expectContained(page);
    const fonts = await page.locator('.mob-settings select').evaluateAll(els => els.map(el => parseFloat(getComputedStyle(el).fontSize)));
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every(size => size >= 16)).toBe(true);
    await nav.getByRole('button', { name: 'Approvals', exact: true }).click();
    await expectContained(page);
    expect(errors).toEqual([]);
  });
}

test('chat composer and transcript fit above an on-screen keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await page.getByRole('button', { name: /Improve mobile layouts and usability/ }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this message visible');
  // Chromium desktop does not display an OS keyboard. Simulate the visual
  // viewport events browsers deliver when the keyboard covers the layout viewport.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 10 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.mob-app')).toHaveAttribute('data-keyboard', 'open');
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeHidden();
  const composer = await page.locator('.mob-composer').boundingBox();
  const feed = await page.locator('.mob-chat-feed').boundingBox();
  expect(composer.y + composer.height).toBeLessThanOrEqual(370);
  expect(composer.height).toBeLessThan(180);
  expect(feed.height).toBeGreaterThan(80);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await page.getByRole('textbox', { name: 'Message', exact: true }).blur();
  await page.evaluate(() => {
    delete window.visualViewport.height;
    delete window.visualViewport.offsetTop;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.mob-app')).toHaveAttribute('data-keyboard', 'closed');
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
});
