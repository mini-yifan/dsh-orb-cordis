const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshLasso', {
  trail: {
    onShow(callback) {
      ipcRenderer.on('lasso-trail-show', (_event, payload) => callback(payload))
    },
    onPoint(callback) {
      ipcRenderer.on('lasso-trail-point', (_event, point) => callback(point))
    },
    onFade(callback) {
      ipcRenderer.on('lasso-trail-fade', (_event, points) => callback(points))
    },
    onReject(callback) {
      ipcRenderer.on('lasso-trail-reject', (_event, points) => callback(points))
    },
    onAppearance(callback) {
      ipcRenderer.on('lasso-appearance', (_event, payload) => callback(payload))
    },
  },
  confirm: {
    onShow(callback) {
      ipcRenderer.on('lasso-confirm-show', (_event, payload) => callback(payload))
    },
    onResult(callback) {
      ipcRenderer.on('lasso-confirm-result', (_event, payload) => callback(payload))
    },
    onAppearance(callback) {
      ipcRenderer.on('lasso-appearance', (_event, payload) => callback(payload))
    },
    action(payload) {
      ipcRenderer.send('lasso:action', payload)
    },
    cancel() {
      ipcRenderer.send('lasso:cancel')
    },
  },
  preview: {
    onImage(callback) {
      ipcRenderer.on('lasso-preview-image', (_event, payload) => callback(payload))
    },
    onAppearance(callback) {
      ipcRenderer.on('lasso-appearance', (_event, payload) => callback(payload))
    },
    close() {
      ipcRenderer.send('lasso:preview-close')
    },
  },
})
