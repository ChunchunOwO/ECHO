import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/constants/ipcChannels';
import type { EchoApi } from './apiTypes';

const echoApi: EchoApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IpcChannels.AppGetVersion),
    minimize: () => ipcRenderer.invoke(IpcChannels.AppWindowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IpcChannels.AppWindowToggleMaximize),
    close: () => ipcRenderer.invoke(IpcChannels.AppWindowClose),
  },
  library: {
    chooseFolder: () => ipcRenderer.invoke(IpcChannels.LibraryChooseFolder),
    addFolder: (path) => ipcRenderer.invoke(IpcChannels.LibraryAddFolder, path),
    getFolders: () => ipcRenderer.invoke(IpcChannels.LibraryGetFolders),
    removeFolder: (folderId) => ipcRenderer.invoke(IpcChannels.LibraryRemoveFolder, folderId),
    scanFolder: (folderId) => ipcRenderer.invoke(IpcChannels.LibraryScanFolder, folderId),
    getScanStatus: (jobId) => ipcRenderer.invoke(IpcChannels.LibraryGetScanStatus, jobId),
    cancelScan: (jobId) => ipcRenderer.invoke(IpcChannels.LibraryCancelScan, jobId),
    getTracks: (query) => ipcRenderer.invoke(IpcChannels.LibraryGetTracks, query),
    getAlbums: (query) => ipcRenderer.invoke(IpcChannels.LibraryGetAlbums, query),
    getAlbumTracks: (albumId, query) => ipcRenderer.invoke(IpcChannels.LibraryGetAlbumTracks, albumId, query),
    getSummary: () => ipcRenderer.invoke(IpcChannels.LibraryGetSummary),
    getDiagnostics: () => ipcRenderer.invoke(IpcChannels.LibraryGetDiagnostics),
  },
  playback: {
    getStatus: () => ipcRenderer.invoke(IpcChannels.PlaybackGetStatus),
    playLocalFile: (request) => ipcRenderer.invoke(IpcChannels.PlaybackPlayLocalFile, request),
    play: () => ipcRenderer.invoke(IpcChannels.PlaybackPlay),
    pause: () => ipcRenderer.invoke(IpcChannels.PlaybackPause),
    stop: () => ipcRenderer.invoke(IpcChannels.PlaybackStop),
    seek: (positionSeconds) => ipcRenderer.invoke(IpcChannels.PlaybackSeek, positionSeconds),
    openLocalAudioFile: () => ipcRenderer.invoke(IpcChannels.PlaybackOpenLocalAudioFile),
  },
  audio: {
    getStatus: () => ipcRenderer.invoke(IpcChannels.AudioGetStatus),
    listDevices: () => ipcRenderer.invoke(IpcChannels.AudioListDevices),
    setOutput: (settings) => ipcRenderer.invoke(IpcChannels.AudioSetOutput, settings),
  },
  eq: {
    getState: () => ipcRenderer.invoke(IpcChannels.EqGetState),
    setEnabled: (enabled) => ipcRenderer.invoke(IpcChannels.EqSetEnabled, enabled),
    setBandGain: (request) => ipcRenderer.invoke(IpcChannels.EqSetBandGain, request),
    setPreamp: (preampDb) => ipcRenderer.invoke(IpcChannels.EqSetPreamp, preampDb),
    setPreset: (presetId) => ipcRenderer.invoke(IpcChannels.EqSetPreset, presetId),
    reset: () => ipcRenderer.invoke(IpcChannels.EqReset),
    listPresets: () => ipcRenderer.invoke(IpcChannels.EqListPresets),
    savePreset: (request) => ipcRenderer.invoke(IpcChannels.EqSavePreset, request),
    deletePreset: (presetId) => ipcRenderer.invoke(IpcChannels.EqDeletePreset, presetId),
  },
};

contextBridge.exposeInMainWorld('echo', echoApi);
