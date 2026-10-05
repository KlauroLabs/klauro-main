const { app, ipcMain } = require('electron');

ipcMain.handle('load-document', async (event, id) => {
  return { id };
});

ipcMain.on('close-document', (event, id) => {
  app.quit();
});
