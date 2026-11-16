// Builds dist/Workeve-win32-x64/Workeve.exe without electron-packager (its zip extractor fails silently on some
// Windows setups). It copies the Electron runtime, renames electron.exe, and puts the app in resources/app, which is the
// layout Electron itself documents for an unpacked app. Run `npm run pack`.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const runtime = path.join('node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(runtime, 'electron.exe'))) {
  console.error('node_modules/electron/dist/electron.exe is missing. Unzip the cached Electron zip there (see README).');
  process.exit(1);
}
const out = path.join('dist', 'Workeve-win32-x64');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(runtime, out, { recursive: true });
fs.renameSync(path.join(out, 'electron.exe'), path.join(out, 'Workeve.exe'));
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
const app = path.join(out, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
for (const f of ['main.js', 'chat-engine.js', 'chat-bridge.js', 'chat-web.js', 'preload.js', 'shell-preload.js', 'setup.js', 'start.html', 'start-page.js', 'chat.html', 'chat.css', 'chat.js', 'chat-md.js', 'chat-boot.js', 'package.json', 'icon.png']) fs.copyFileSync(f, path.join(app, f));

(async () => {
  try {
    const rcedit = require('rcedit');
    await (rcedit.rcedit || rcedit)(path.join(out, 'Workeve.exe'), {
      icon: 'icon.ico',
      'version-string': { ProductName: 'Workeve', FileDescription: 'Workeve', CompanyName: 'Workerov', OriginalFilename: 'Workeve.exe' },
    });
    console.log('icon and version info stamped on the exe');
  } catch (e) {
    console.log('built without a custom exe icon (' + String(e.message).slice(0, 100) + ')');
  }
  const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  console.log(`built ${path.join(out, 'Workeve.exe')} (${Math.round(size(out) / 1048576)} MB folder)`);
})();
