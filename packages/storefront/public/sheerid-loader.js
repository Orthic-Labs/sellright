// Lazy load SheerID only when needed to avoid blocking critical path
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => {
    import("https://cdn.jsdelivr.net/npm/@sheerid/jslib@2/sheerid-install.js")
      .then(module => { window.sheerId = module.default; });
  });
} else {
  setTimeout(() => {
    import("https://cdn.jsdelivr.net/npm/@sheerid/jslib@2/sheerid-install.js")
      .then(module => { window.sheerId = module.default; });
  }, 1);
}