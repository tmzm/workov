// electron-builder hook: stamps the Ejad icon and version info on the exe, so the taskbar, Start menu and Apps list
// show it instead of the default Electron atom. (electron-builder's own editing needs a download that fails on some
// Windows setups, so the rcedit package does it here.)
'use strict';
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  const rcedit = require('rcedit');
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  await (rcedit.rcedit || rcedit)(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'version-string': { ProductName: 'Ejad Fleet', FileDescription: 'Ejad Fleet', CompanyName: 'Ejad', OriginalFilename: 'Ejad Fleet.exe' },
  });
};
