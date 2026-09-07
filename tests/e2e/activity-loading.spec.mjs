import { expect, test } from '@playwright/test';

for (const mobile of [false, true]) {
  test(`activity loads progressively on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const project = { id: 'loading', workspaceId: 'loading', name: 'Loading workspace',
      path: '/workspace/loading', sourceRoot: '/workspace/loading', hasSidecar: true,
      lastOpened: new Date().toISOString(), nodes: [], settings: {}, skills: [],
      transform: { x: 0, y: 0, scale: 1 } };
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const json = path.endsWith('/auth/token') ? { token: 'loading-test' }
        : path === '/api/projects' ? [project]
        : path === '/api/projects/loading' ? project
        : path === '/api/readiness' ? { harnesses: [] }
        : path.includes('skills') ? [] : {};
      return route.fulfill({ json });
    });
    const requests = [];
    let send;
    await page.routeWebSocket('**/ws*', socket => {
      send = data => socket.send(JSON.stringify({ topic: 'global', ...data }));
      socket.onMessage(raw => {
        const message = JSON.parse(raw);
        if (message.type === 'list_work_items') requests.push(message);
        if (message.type === 'list_harnesses') send({ type: 'harness_list', harnesses: [] });
      });
    });
    await page.goto(mobile ? '/m' : '/');
    await page.getByText('Loading workspace', { exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Loading activity' })).toBeVisible();
    await expect(page.getByText('No active sessions', { exact: true })).toBeHidden();
    await expect(page.getByLabel('Empty session list')).toBeHidden();
    await expect(page.locator('.act-launch-panel')).toBeHidden();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].limit).toBe(20);
    send({ type: 'session_list', sessions: [] });
    await expect(page.getByRole('status').filter({ hasText: 'Loading activity' })).toBeVisible();
    await page.screenshot({ path: `/tmp/activity-loading-${mobile ? 'mobile' : 'desktop'}.png` });
    const reply = (request, items, nextCursor) => send({ type: 'work_item_response',
      command: 'list_work_items', requestId: request.requestId, success: true,
      result: { projectId: project.id, items, nextCursor } });
    reply(requests[0], [{ id: 'recent', projectId: project.id, projectPath: project.path,
      title: 'Recent activity arrived', lifecycle: { runtimeState: 'working', outcome: 'none',
        resolution: 'open', changeMode: 'live', integrationState: 'live_editing', lifecycleRevision: 1 },
      waitKind: null, currentRunKey: 'recent-run', iteration: 1,
      createdAt: 1, updatedAt: 2, lastTransitionAt: 2 }], 'older');
    const list = page.locator(mobile ? '.mob-activity' : '.act-main');
    await expect(list.getByText('Recent activity arrived', { exact: true })).toBeVisible();
    await expect(list.getByRole('status')).toHaveText('Loading more activity…');
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toMatchObject({ cursor: 'older', limit: 100 });
    reply(requests[1], [], null);
    await expect(list.getByRole('status')).toBeHidden();
    await expect(list.getByText('Recent activity arrived', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
    expect(errors).toEqual([]);
  });
}
