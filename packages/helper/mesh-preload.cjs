const { contextBridge, ipcRenderer } = require('electron')

// The Mesh window is a separate renderer. It only sees these calls: the main process
// validates every path against the host's `/.dsh-orb/mesh/*` surface and adds the
// helper token itself, so no credential enters this page.
contextBridge.exposeInMainWorld('dshMesh', {
  request(method, path, body) {
    return ipcRenderer.invoke('orb:mesh-request', { method, path, body })
  },
  openSettings() {
    ipcRenderer.send('orb:mesh-open-settings')
  },
  onAppearance(callback) {
    ipcRenderer.on('mesh:appearance', (_event, appearance) => callback(appearance))
  },
})