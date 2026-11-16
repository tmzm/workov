// Sets the saved theme and light/dark mode before the first paint, so the window never flashes the wrong colours.
(function () {
  var r = document.documentElement, theme = 'tmzm', mode = '';
  try { theme = localStorage.getItem('chat.theme') || theme; mode = localStorage.getItem('chat.mode') || ''; } catch (e) { /* private window */ }
  if (!/^(andon|cyberpunk|tmzm)$/.test(theme)) theme = 'tmzm';
  if (mode !== 'dark' && mode !== 'light') mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  var q = new URLSearchParams(location.search);
  window.APP_NAME = /^[^<>&"']{1,40}$/.test(q.get('name') || '') ? q.get('name') : 'Workerov';
  if (q.get('web') === '1') document.write('<script src="chat-web.js"><\/script>');
  if (q.get('embedded') === '1') {
    r.classList.add('embedded');
    if (/^(andon|cyberpunk|tmzm)$/.test(q.get('theme') || '')) { theme = q.get('theme'); mode = q.get('mode') === 'light' ? 'light' : 'dark'; if (/^#[0-9a-f]{3,8}$/i.test(q.get('bg') || '')) r.style.setProperty('--bg', q.get('bg')); }
    else { r.classList.add('pending'); setTimeout(function () { r.classList.remove('pending'); }, 800); }
  }
  r.setAttribute('data-theme', theme); r.setAttribute('data-mode', mode);
})();
