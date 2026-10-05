const { ipcRenderer } = require('electron');

window.api = {
  load: id => ipcRenderer.invoke('load-document', id),
  close: id => ipcRenderer.send('close-document', id),
  ping: () => ipcRenderer.invoke('unhandled-channel'),
};
