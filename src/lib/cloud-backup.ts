import { WebContainer } from '@webcontainer/api';

interface FileRecord {
  id: string;
  projectId: string;
  path: string;
  type: 'file' | 'folder';
  content?: string;
  compressed?: boolean;
  size?: number;
  compressedSize?: number;
}

interface ChangedFiles {
  changed: FileRecord[];
  deleted: string[];
}

interface SyncResponse {
  synced: number;
  skipped: number;
  errors: string[];
  lastSyncAt: string;
}

/**
 * CloudBackupManager handles automatic cloud sync and restore for WebContainer files
 * Syncs to Postgres (text files) and UploadThing (binary assets)
 */
export class CloudBackupManager {
  private static instance: CloudBackupManager;
  private syncTimeout: NodeJS.Timeout | null = null;
  private isSyncing: boolean = false;
  private lastSyncTime: number = 0;
  private readonly DEBOUNCE_MS = 5000; // 5 seconds
  private readonly MAX_FILE_SIZE = 1024 * 1024; // 1MB
  private readonly BATCH_SIZE = 10; // Max files per batch

  private constructor() {}

  static getInstance(): CloudBackupManager {
    if (!CloudBackupManager.instance) {
      CloudBackupManager.instance = new CloudBackupManager();
    }
    return CloudBackupManager.instance;
  }

  /**
   * Main sync method - called after IndexedDB save
   * Debounced to prevent rapid syncs during active editing
   */
  async syncToCloud(projectId: string, container: WebContainer): Promise<void> {
    // Clear any pending sync
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    // Debounce: wait 5 seconds after last file change
    this.syncTimeout = setTimeout(async () => {
      await this.performSync(projectId, container);
    }, this.DEBOUNCE_MS);
  }

  /**
   * Restore from cloud when IndexedDB is empty
   * Returns true if restore was successful
   */
  async restoreFromCloud(projectId: string, container: WebContainer): Promise<boolean> {
    try {
      console.log(`☁️  Attempting to restore from cloud for project ${projectId}...`);

      // 1. Fetch cloud backup
      const res = await fetch(`/api/projects/${projectId}/backup/restore`);
      if (!res.ok) {
        if (res.status === 404) {
          // No backup exists yet - this is normal for new projects
          return false;
        }
        if (res.status === 401) {
          // Auth not ready yet - silently fail, will use template
          return false;
        }
        console.warn(`Cloud restore failed: ${res.status} ${res.statusText}`);
        return false;
      }

      const data = await res.json();
      const { files, folders } = data;

      if (!files || files.length === 0) {
        // No files backed up yet - normal for new projects
        return false;
      }

      console.log(`📦 Restoring ${files.length} files from cloud...`);

      // 2. Create folder structure
      for (const folder of folders) {
        try {
          await container.fs.mkdir(folder, { recursive: true });
        } catch (error) {
          console.warn(`Failed to create folder ${folder}:`, error);
        }
      }

      // 3. Write files
      for (const file of files) {
        try {
          if (file.content) {
            // Text file - write directly
            await container.fs.writeFile(file.path, file.content);
          } else if (file.url) {
            // Binary asset - download and write
            const assetRes = await fetch(file.url);
            const blob = await assetRes.blob();
            const arrayBuffer = await blob.arrayBuffer();
            await container.fs.writeFile(file.path, new Uint8Array(arrayBuffer));
          }
        } catch (error) {
          console.warn(`Failed to restore file ${file.path}:`, error);
        }
      }

      console.log(`✅ Restored ${files.length} files from cloud`);
      return true;
    } catch (error) {
      console.error('Failed to restore from cloud:', error);
      return false;
    }
  }

  /**
   * Perform the actual sync operation
   */
  private async performSync(projectId: string, container: WebContainer): Promise<void> {
    if (this.isSyncing) {
      console.log('⏭️ Skipping sync: already syncing');
      return;
    }

    try {
      this.isSyncing = true;
      this.dispatchEvent('cloud-sync-start');

      console.log(`☁️  Starting cloud sync for project ${projectId}...`);

      // 1. Get all files from WebContainer
      const localFiles = await this.getAllFiles(container);

      // 2. Filter files for backup
      const filesToBackup = localFiles.filter((f) => this.shouldBackup(f));

      if (filesToBackup.length === 0) {
        console.log('No files to sync');
        this.dispatchEvent('cloud-sync-complete');
        return;
      }

      // 3. Detect changes compared to cloud
      const { changed, deleted } = await this.detectChanges(projectId, filesToBackup);

      if (changed.length === 0 && deleted.length === 0) {
        console.log('✅ Everything up to date (no changes detected)');
        this.dispatchEvent('cloud-sync-complete');
        return;
      }

      console.log(`📊 Changes detected: ${changed.length} modified, ${deleted.length} deleted`);

      // 4. Compute hashes for changed files
      const filesWithHashes = await Promise.all(
        changed.map(async (file) => ({
          path: file.path,
          content: file.content || '',
          hash: await this.computeHash(file.content || ''),
          size: file.size || 0,
          mimeType: this.getMimeType(file.path),
        }))
      );

      // 5. Build new manifest
      const manifest: Record<string, string> = {};
      for (const file of filesWithHashes) {
        manifest[file.path] = file.hash;
      }

      // 6. Upload in batches
      await this.uploadBatch(projectId, filesWithHashes, deleted, manifest);

      console.log(`✅ Cloud sync complete for project ${projectId}`);
      this.lastSyncTime = Date.now();
      this.dispatchEvent('cloud-sync-complete');
    } catch (error) {
      console.error('Cloud sync failed:', error);
      this.dispatchEvent('cloud-sync-error', { error });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Detect changes by comparing local files with cloud manifest
   */
  private async detectChanges(projectId: string, localFiles: FileRecord[]): Promise<ChangedFiles> {
    try {
      // 1. Fetch cloud manifest
      const res = await fetch(`/api/projects/${projectId}/backup/manifest`);
      if (!res.ok) {
        // No manifest yet - all files are new
        return { changed: localFiles, deleted: [] };
      }

      const data = await res.json();
      const cloudManifest: Record<string, string> = data.manifest || {};

      // 2. Compute local hashes
      const localManifest: Record<string, string> = {};
      for (const file of localFiles) {
        if (file.content) {
          localManifest[file.path] = await this.computeHash(file.content);
        }
      }

      // 3. Find changed files (new or modified)
      const changed: FileRecord[] = [];
      for (const [path, hash] of Object.entries(localManifest)) {
        if (cloudManifest[path] !== hash) {
          const file = localFiles.find((f) => f.path === path);
          if (file) {
            changed.push(file);
          }
        }
      }

      // 4. Find deleted files (in cloud but not local)
      const deleted: string[] = [];
      for (const path of Object.keys(cloudManifest)) {
        if (!localManifest[path]) {
          deleted.push(path);
        }
      }

      return { changed, deleted };
    } catch (error) {
      console.error('Error detecting changes:', error);
      // On error, assume all files changed (safe fallback)
      return { changed: localFiles, deleted: [] };
    }
  }

  /**
   * Upload files in batch to /api/projects/[id]/backup/sync
   */
  private async uploadBatch(
    projectId: string,
    files: Array<{ path: string; content: string; hash: string; size: number; mimeType: string }>,
    deletedPaths: string[],
    manifest: Record<string, string>
  ): Promise<void> {
    // Split into chunks of BATCH_SIZE
    for (let i = 0; i < files.length; i += this.BATCH_SIZE) {
      const batch = files.slice(i, i + this.BATCH_SIZE);

      try {
        const res = await fetch(`/api/projects/${projectId}/backup/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: batch,
            deletedPaths: i === 0 ? deletedPaths : [], // Only delete on first batch
            manifest,
          }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          console.error('Sync API error:', res.status, errorText);
          throw new Error(`Sync failed (${res.status}): ${errorText}`);
        }

        const result: SyncResponse = await res.json();
        console.log(
          `📤 Batch ${Math.floor(i / this.BATCH_SIZE) + 1}: synced=${result.synced}, skipped=${result.skipped}`
        );

        if (result.errors.length > 0) {
          console.warn('Sync errors:', result.errors);
        }
      } catch (error) {
        console.error(`Failed to sync batch ${Math.floor(i / this.BATCH_SIZE) + 1}:`, error);
        // Continue with next batch even if one fails
      }
    }
  }

  /**
   * Compute SHA-256 hash for file content
   */
  private async computeHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256-${hashHex}`;
  }

  /**
   * Determine if file should be backed up to cloud
   */
  private shouldBackup(file: FileRecord): boolean {
    // Only files, not folders
    if (file.type !== 'file' || !file.content) {
      return false;
    }

    // Exclude system directories
    if (file.path.includes('node_modules') || file.path.includes('.git')) {
      return false;
    }

    // Exclude large files (>1MB)
    if (file.size && file.size > this.MAX_FILE_SIZE) {
      console.log(`⏭️ Skipping ${file.path}: too large (${file.size} bytes)`);
      return false;
    }

    return true;
  }

  /**
   * Get all files from WebContainer (recursive)
   */
  private async getAllFiles(container: WebContainer): Promise<FileRecord[]> {
    const files: FileRecord[] = [];

    async function processDirectory(path: string) {
      try {
        const entries = await container.fs.readdir(path, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;

          if (entry.isDirectory()) {
            // Skip directories that are never backed up — avoids reading thousands
            // of node_modules files which makes cloud sync extremely slow.
            if (entry.name === 'node_modules' || entry.name === '.git') {
              continue;
            }
            files.push({
              id: fullPath,
              projectId: '',
              path: fullPath,
              type: 'folder',
            });
            await processDirectory(fullPath);
          } else {
            try {
              const content = await container.fs.readFile(fullPath, 'utf8');
              files.push({
                id: fullPath,
                projectId: '',
                path: fullPath,
                type: 'file',
                content,
                size: content.length,
              });
            } catch {
              // Handle binary files or read errors
              files.push({
                id: fullPath,
                projectId: '',
                path: fullPath,
                type: 'file',
              });
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

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      js: 'text/javascript',
      ts: 'text/typescript',
      tsx: 'text/typescript',
      jsx: 'text/javascript',
      json: 'application/json',
      html: 'text/html',
      css: 'text/css',
      md: 'text/markdown',
      txt: 'text/plain',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
    };

    return mimeTypes[ext || ''] || 'text/plain';
  }

  /**
   * Dispatch custom events for sync status
   */
  private dispatchEvent(type: string, detail?: unknown): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }
}
