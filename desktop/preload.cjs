const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rautmlDesktop', {
  renderPdf: (html) => ipcRenderer.invoke('rautml:render-pdf', html),
})

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = 'electron'
})
