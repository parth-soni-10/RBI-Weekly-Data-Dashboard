/* Pick the theme before first paint to avoid a flash: a stored choice wins,
   otherwise the site opens light.

   The operating system is not consulted. `:root[data-theme="light"]` is the
   token set the dashboard is drawn on, and the markup ships the same attribute
   statically, so a JS-off visitor and a dark-mode visitor both get light rather
   than only the one whose laptop happens to be set that way. Dark is one click
   away and stays remembered once chosen. */
(function () {
  try {
    var s = localStorage.getItem('rbi-theme');
    var t = (s === 'light' || s === 'dark') ? s : 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'light'; }
})();
