// Only the setup screen uses this: progress events in, two buttons out.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stagelight", {
  on: (channel, fn) => {
    if (["log", "step", "failed", "first-run", "reset"].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
  retry: () => ipcRenderer.send("retry"),
  openLog: () => ipcRenderer.send("open-log"),
});
