self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      const parsed = event.data.json();
      data =
        parsed && typeof parsed === 'object'
          ? parsed
          : { body: String(parsed ?? '') };
    } catch {
      data = { body: event.data.text() };
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'myplan reminder', {
      body: data.body || 'You have an item that needs attention.',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: data.tag || 'myplan-reminder',
      data: { url: data.url || '/' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const target = event.notification.data?.url || '/';
        const open = clients.find((client) => 'focus' in client);
        if (!open) return self.clients.openWindow(target);
        return open.navigate(target).then(() => open.focus());
      }),
  );
});
