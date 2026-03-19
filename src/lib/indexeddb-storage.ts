// IndexedDB storage for WebContainer files with compression
import { WebContainer } from '@webcontainer/api';

const DB_NAME = 'webcontainer-projects';
const DB_VERSION = 1;
const FILES_STORE = 'files';

interface FileRecord {
  id: string; // projectId-filepath
  projectId: string;
  path: string;
  type: 'file' | 'folder';
  content?: string; // Only for files
  compressed?: boolean;
  size?: number;
  compressedSize?: number;
}

class IndexedDBStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private saveTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private lastSaveTime: Map<string, number> = new Map();
  private readonly MIN_SAVE_INTERVAL = 1000; // Minimum 1 second between saves

  private async getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          
          // Create files store if it doesn't exist
          if (!db.objectStoreNames.contains(FILES_STORE)) {
            const store = db.createObjectStore(FILES_STORE, { keyPath: 'id' });
            store.createIndex('projectId', 'projectId', { unique: false });
          }
        };
      });
    }
    return this.dbPromise;
  }

  private compress(text: string): string {
    // Simple compression using built-in compression
    try {
      const compressed = btoa(
        new Uint8Array(
          new TextEncoder().encode(text)
        ).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      return compressed;
    } catch (error) {
      console.warn('Compression failed, storing uncompressed:', error);
      return text;
    }
  }

  private decompress(compressed: string, isCompressed: boolean): string {
    if (!isCompressed) return compressed;
    
    try {
      const binary = atob(compressed);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    } catch (error) {
      console.warn('Decompression failed, returning as-is:', error);
      return compressed;
    }
  }

  // Debounced save to prevent excessive saves
  async saveProjectStateDebounced(projectId: string, container: WebContainer): Promise<void> {
    // Clear any existing timeout for this project
    const existingTimeout = this.saveTimeouts.get(projectId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Check if we saved too recently
    const lastSave = this.lastSaveTime.get(projectId) || 0;
    const timeSinceLastSave = Date.now() - lastSave;

    if (timeSinceLastSave < this.MIN_SAVE_INTERVAL) {
      // Debounce: wait before saving
      const timeout = setTimeout(() => {
        this.saveProjectStateNow(projectId, container);
        this.saveTimeouts.delete(projectId);
      }, this.MIN_SAVE_INTERVAL - timeSinceLastSave);
      
      this.saveTimeouts.set(projectId, timeout);
    } else {
      // Save immediately
      await this.saveProjectStateNow(projectId, container);
    }
  }

  async saveProjectState(projectId: string, container: WebContainer): Promise<void> {
    return this.saveProjectStateDebounced(projectId, container);
  }

  private async saveProjectStateNow(projectId: string, container: WebContainer): Promise<void> {
    try {
      // First, collect all data outside of any transaction
      const files = await this.getAllFiles(container);
      const records: FileRecord[] = [];
      let totalSize = 0;
      let compressedSize = 0;

      // Prepare all records before starting transaction
      for (const [path, fileData] of Object.entries(files)) {
        // Skip system files
        if (path.includes('node_modules') || path.includes('.git')) continue;

        const record: FileRecord = {
          id: `${projectId}-${path}`,
          projectId,
          path,
          type: fileData.type as 'file' | 'folder'
        };

        if (fileData.type === 'file' && fileData.content) {
          const originalSize = fileData.content.length;
          const compressed = this.compress(fileData.content);
          const isSmaller = compressed.length < originalSize;
          
          record.content = isSmaller ? compressed : fileData.content;
          record.compressed = isSmaller;
          record.size = originalSize;
          record.compressedSize = record.content.length;
          
          totalSize += originalSize;
          compressedSize += record.content.length;
        }

        records.push(record);
      }

      // Now perform all database operations in a single transaction
      const db = await this.getDB();
      
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([FILES_STORE], 'readwrite');
        const store = transaction.objectStore(FILES_STORE);
        const index = store.index('projectId');
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(new Error('Transaction aborted'));

        // Clear existing files for this project
        const clearRequest = index.getAllKeys(projectId);
        clearRequest.onsuccess = () => {
          const existingKeys = clearRequest.result;
          
          // Delete existing files
          for (const key of existingKeys) {
            store.delete(key);
          }
          
          // Add new files
          for (const record of records) {
            store.put(record);
          }
        };
        clearRequest.onerror = () => reject(clearRequest.error);
      });

      // Record save time
      this.lastSaveTime.set(projectId, Date.now());

      console.log(`SAVE webcontainer-${projectId} files: ${records.length} size: ${(totalSize / 1024).toFixed(2)}KB compressed: ${(compressedSize / 1024).toFixed(2)}KB`);

      // NEW: Trigger cloud sync after IndexedDB save completes
      if (typeof window !== 'undefined') {
        // Dynamic import to avoid circular dependencies
        import('./cloud-backup').then(({ CloudBackupManager }) => {
          CloudBackupManager.getInstance().syncToCloud(projectId, container);
        }).catch(error => {
          console.error('Failed to trigger cloud sync:', error);
        });
      }
    } catch (error) {
      console.error('Failed to save to IndexedDB:', error);
      throw error;
    }
  }

  async loadProjectState(projectId: string): Promise<Record<string, { type: string; content?: string }> | null> {
    try {
      const db = await this.getDB();
      const transaction = db.transaction([FILES_STORE], 'readonly');
      const store = transaction.objectStore(FILES_STORE);
      const index = store.index('projectId');

      const files = await new Promise<FileRecord[]>((resolve, reject) => {
        const request = index.getAll(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      if (files.length === 0) {
        return null;
      }

      const result: Record<string, { type: string; content?: string }> = {};
      
      for (const file of files) {
        result[file.path] = {
          type: file.type
        };

        if (file.type === 'file' && file.content) {
          result[file.path].content = this.decompress(file.content, file.compressed || false);
        }
      }

      console.log(`LOAD webcontainer-${projectId} found ${files.length} files`);
      return result;
    } catch (error) {
      console.warn('Failed to load project state from IndexedDB:', error);
      return null;
    }
  }

  private async getAllFiles(container: WebContainer): Promise<Record<string, { type: string; content?: string }>> {
    const files: Record<string, { type: string; content?: string }> = {};
    
    async function processDirectory(path: string) {
      try {
        const entries = await container.fs.readdir(path, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
          
          if (entry.isDirectory()) {
            // Skip directories that are never saved — avoids reading thousands of
            // node_modules files (e.g. lucide-react has 1400+ icon files) which
            // makes saveProjectStateNow very slow and causes concurrent-save races.
            if (entry.name === 'node_modules' || entry.name === '.git') {
              continue;
            }
            files[fullPath] = { type: 'folder' };
            await processDirectory(fullPath);
          } else {
            try {
              const content = await container.fs.readFile(fullPath, 'utf8');
              files[fullPath] = { 
                type: 'file',
                content: content
              };
            } catch {
              // Handle binary files or read errors
              files[fullPath] = { type: 'file' };
            }
          }
        }
      } catch (error) {
        console.warn(`Error reading directory ${path}:`, error);
      }
    }

    await processDirectory('/');
    return files;
  }

  async restoreFiles(container: WebContainer, files: Record<string, { type: string; content?: string }>): Promise<void> {
    console.log(`🗑️ Clearing existing files (keeping node_modules)...`);
    // Clear existing files first (except node_modules)
    try {
      const entries = await container.fs.readdir('/', { withFileTypes: true });
      console.log(`📁 Found ${entries.length} entries in root:`, entries.map(e => e.name));
      for (const entry of entries) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          console.log(`  🗑️ Removing: /${entry.name}`);
          await container.fs.rm(`/${entry.name}`, { recursive: true, force: true });
        } else {
          console.log(`  ⏭️ Skipping: /${entry.name}`);
        }
      }
    } catch (error) {
      console.warn('Failed to clear existing files:', error);
    }

    // Restore files
    const sortedPaths = Object.keys(files).sort((a, b) => a.length - b.length);
    console.log(`📦 Restoring ${sortedPaths.length} files/folders...`);

    for (const filePath of sortedPaths) {
      const fileData = files[filePath];
      
      if (fileData.type === 'folder') {
        try {
          await container.fs.mkdir(filePath, { recursive: true });
        } catch (error) {
          console.warn(`Failed to create directory ${filePath}:`, error);
        }
      } else if (fileData.type === 'file' && fileData.content !== undefined) {
        try {
          // Ensure parent directory exists
          const parentDir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
          if (parentDir !== '/') {
            await container.fs.mkdir(parentDir, { recursive: true });
          }

          await container.fs.writeFile(filePath, fileData.content);

          // Log key files for debugging
          if (filePath === '/src/App.tsx' || filePath === '/index.html') {
            console.log(`✍️ Wrote ${filePath} (${fileData.content.length} bytes, first 100 chars):`, fileData.content.substring(0, 100));
          }
        } catch (error) {
          console.warn(`Failed to restore file ${filePath}:`, error);
        }
      }
    }
  }
}

export const indexedDBStorage = new IndexedDBStorage();