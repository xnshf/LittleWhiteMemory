import { getRequestHeaders } from '../../../../../../script.js';
import { StorageFile } from './storage-file.js';

export const CommonSettingStorage = new StorageFile('LittleWhiteMemory_CommonSettings.json', {
    debounceMs: 1000,
    getRequestHeaders,
});
