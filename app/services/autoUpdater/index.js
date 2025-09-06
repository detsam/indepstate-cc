const { autoUpdater } = require('electron-updater');

function start(opts = {}) {
  const {
    autoDownload = true,
    allowPrerelease = false,
    provider = 'github',
    owner,
    repo,
  } = opts;
  try {
    autoUpdater.autoDownload = autoDownload;
    autoUpdater.allowPrerelease = allowPrerelease;
  } catch {}

  if (owner && repo) {
    try {
      autoUpdater.setFeedURL({ provider, owner, repo });
    } catch {}
  }

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err);
  });

  autoUpdater.on('update-downloaded', () => {
    try {
      autoUpdater.quitAndInstall();
    } catch {}
  });

  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.error('[auto-updater] check failed', err);
  }

  return autoUpdater;
}

module.exports = { start };
