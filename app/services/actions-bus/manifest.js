const path = require('path');
const settings = require('../settings');
const loadConfig = require('../../config/load');
const { createActionsBus } = require('.');

let ipcMain;
try {
  ({ ipcMain } = require('electron'));
} catch {
  ipcMain = null;
}

settings.register(
  'actions-bus',
  path.join(__dirname, 'config', 'actions-bus.json'),
  path.join(__dirname, 'config', 'actions-bus-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  let cfg = {};
  try {
    cfg = loadConfig('../services/actions-bus/config/actions-bus.json');
  } catch {
    cfg = {};
  }

  const bus = servicesApi.actionBus && typeof servicesApi.actionBus.emit === 'function'
    ? servicesApi.actionBus
    : createActionsBus({
        onError(err, entry) {
          console.error('[actions-bus]', err.message || err, entry?.event || entry);
        }
      });

  servicesApi.actionBus = bus;

  const enabled = cfg.enabled !== false;
  if (enabled && Array.isArray(cfg.actions)) {
    bus.configure(cfg.actions);
  } else {
    bus.configure([]);
  }

  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('actions-bus:list', () => bus.listNamedActions());
    ipcMain.handle('actions-bus:set-enabled', (_evt, name, enabledState) => {
      if (typeof name === 'string') {
        bus.setActionEnabled(name, !!enabledState);
      }
      return bus.listNamedActions();
    });
  }
}

function hookRenderer(ipcRenderer) {
  const container = document.getElementById('actions-bus-toggles');
  if (!container || !ipcRenderer) return;
  const visibleClass = 'actions-bus-toggles--visible';

  function render(list) {
    container.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      container.classList.remove(visibleClass);
      return;
    }
    container.classList.add(visibleClass);
    list.forEach((item) => {
      if (!item || typeof item.name !== 'string') return;
      const label = document.createElement('label');
      label.className = 'actions-bus-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.enabled !== false;
      checkbox.dataset.name = item.name;
      checkbox.addEventListener('change', () => {
        const checked = checkbox.checked;
        ipcRenderer
          .invoke('actions-bus:set-enabled', item.name, checked)
          .then((nextList) => {
            if (Array.isArray(nextList)) render(nextList);
            else refresh();
          })
          .catch(() => refresh());
      });
      const span = document.createElement('span');
      span.textContent = item.label || item.name;
      label.appendChild(checkbox);
      label.appendChild(span);
      container.appendChild(label);
    });
  }

  function refresh() {
    ipcRenderer
      .invoke('actions-bus:list')
      .then(render)
      .catch(() => {
        container.classList.remove(visibleClass);
        container.innerHTML = '';
      });
  }

  refresh();
}

module.exports = { initService, hookRenderer };
