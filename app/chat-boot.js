// Sets the saved theme and light/dark mode before the first paint, so the window never flashes the wrong colours.
(function () {
  var r = document.documentElement, theme = 'tmzm', mode = '';
  try { theme = localStorage.getItem('chat.theme') || theme; mode = localStorage.getItem('chat.mode') || ''; } catch (e) { /* private window */ }
  if (!/^(andon|cyberpunk|tmzm)$/.test(theme)) theme = 'tmzm';
  if (mode !== 'dark' && mode !== 'light') mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (/[?&]embedded=1/.test(location.search)) r.classList.add('embedded');
  r.setAttribute('data-theme', theme); r.setAttribute('data-mode', mode);
})();
