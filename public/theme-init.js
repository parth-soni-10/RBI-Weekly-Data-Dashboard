/* Pick the theme before first paint to avoid a flash.
 *
 * A stored choice wins; otherwise the dashboard opens light. The operating
 * system is deliberately not consulted - the token set in styles.css is drawn
 * for the light page first, and the toggle is the only route to the dark one,
 * so a visitor on a dark-mode machine does not get a dashboard that looks like
 * a different product.
 */
(function () {
  try {
    var s = localStorage.getItem('rbi-theme');
    document.documentElement.dataset.theme = s === 'dark' ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
