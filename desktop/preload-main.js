// The main window's only bridge: lets the page offer "open Stagelight in your browser", where the
// person is signed in to YouTube (the app window has its own, empty cookie store, and Google
// sign-in is blocked inside Electron).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stagelightDesktop", {
  openInBrowser: (pathAndQuery) => ipcRenderer.send("open-in-browser", String(pathAndQuery || "/")),
});
