self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const notification = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(notification.title ?? "Minions", {
      body: notification.body ?? "",
      data: notification.data ?? {},
      tag: notification.data?.sessionKey,
      icon: "/icons/leader-active.svg",
      badge: "/icons/favicon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/m";
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = all.find((client) => client.url.includes("/m"));
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "push-navigate", url });
    } else {
      await clients.openWindow(url);
    }
  })());
});
