const { ipcMain, BrowserWindow } = require('electron');
const { createCommandService } = require('.');

function initService(servicesApi = {}) {
  const cmdService = createCommandService({
    commands: servicesApi.commands,
    onAdd(row) {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('orders:new', row);
      }
    }
  });
  ipcMain.handle('cmdline:run', (_evt, str) => cmdService.run(str));
}

module.exports = { initService };
