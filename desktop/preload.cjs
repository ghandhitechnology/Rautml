const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rautmlDesktop', {
  renderPdf: (html) => ipcRenderer.invoke('rautml:render-pdf', html),
  retryBoot: () => ipcRenderer.invoke('rautml:retry-boot'),
})

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = 'electron'
})
