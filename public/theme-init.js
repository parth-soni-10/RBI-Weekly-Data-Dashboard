/* Pick the theme before first paint to avoid a flash: a stored choice wins, otherwise the OS preference. */
(function () {
  try {
    var s = localStorage.getItem('rbi-theme');
    var t = (s === 'light' || s === 'dark') ? s
      : (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'dark'; }
})();
