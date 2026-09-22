const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, v) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const paths = (files) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean);

contextBridge.exposeInMainWorld('api', {
  // system + settings
  sysInfo: call('sys:info'), gpuInfo: call('sys:gpu'), specs: call('sys:specs'), openExternal: call('open:external'), quitApp: call('app:quit'),
  getPrefs: call('prefs:get'), setPrefs: call('prefs:set'), newApiKey: call('prefs:newKey'), chooseWorkspace: call('prefs:chooseWorkspace'),
  netTempOn: call('net:tempOn'), netTempOff: call('net:tempOff'),
  checkUpdate: call('update:check'),
  // chats
  loadChats: call('chats:load'), saveChats: call('chats:save'), saveFile: call('file:save'),
  // models
  listModels: call('models:list'), importModels: call('models:import'), removeModel: call('models:remove'), modelInfo: call('models:info'),
  importPaths: (files) => ipcRenderer.invoke('models:importPaths', paths(files)),
  detectImports: call('import:detect'), runImport: call('import:run'), importFolder: call('import:folder'),
  loadModel: (id, opts) => ipcRenderer.invoke('model:load', { id, opts }), unloadModel: call('model:unload'),
  // chat
  send: call('chat:send'), stop: call('chat:stop'), toolAnswer: call('tool:answer'),
  // documents
  pickDocs: call('docs:pick'), addDocs: call('docs:add'), removeDoc: call('docs:remove'), searchDocs: call('docs:search'),
  droppedPaths: paths,
  // compare + voice
  runCompare: call('cmp:run'), stopCompare: call('cmp:stop'),
  voiceStatus: call('voice:status'), transcribe: call('voice:transcribe'),
  // downloads
  modelsDir: call('dl:dir'), chooseModelsDir: call('dl:chooseDir'), hfSearch: call('hf:search'), hfFiles: call('hf:files'),
  dlStart: call('dl:start'), dlStop: call('dl:stop'),
  // events
  onChatEvent: on('chat:event'), onModelStatus: on('model:status'), onLog: on('log'), onDlProgress: on('dl:progress'), onDlState: on('dl:state'),
  onToolAsk: on('tool:ask'), onDocsProgress: on('docs:progress'), onCompareEvent: on('cmp:event'), onModelExternal: on('model:external'),
  onFocus: on('app:focus'), onNewChat: on('app:new-chat'),
});
