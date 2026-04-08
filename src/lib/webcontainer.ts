import { WebContainer } from '@webcontainer/api';
import { indexedDBStorage } from './indexeddb-storage';

export class WebContainerManager {
  private static instance: WebContainer | null = null;
  private static isBooting = false;
  private static bootPromise: Promise<WebContainer> | null = null;

  static async getInstance(): Promise<WebContainer> {
    if (this.instance) {
      return this.instance;
    }

    if (this.isBooting && this.bootPromise) {
      return this.bootPromise;
    }

    this.isBooting = true;
    this.bootPromise = this.boot();

    try {
      this.instance = await this.bootPromise;
      return this.instance;
    } finally {
      this.isBooting = false;
      this.bootPromise = null;
    }
  }

  // Force reset the WebContainer instance
  static async resetInstance(): Promise<WebContainer> {
    console.log('🔄 Forcing WebContainer reset...');
    
    // Clear existing instance
    this.instance = null;
    this.isBooting = false;
    this.bootPromise = null;
    
    // Get fresh instance
    return this.getInstance();
  }

  private static async boot(): Promise<WebContainer> {
    let container: WebContainer;
    try {
      container = await WebContainer.boot({
        coep: 'credentialless'
      });
    } catch (err) {
      console.error('WebContainer boot failed:', err);
      throw err;
    }
    
    // Set up file system watching with debouncing
    let watchTimeout: NodeJS.Timeout;
    container.fs.watch('/', { recursive: true }, (event, filename) => {
      // Debounce file system changes to avoid excessive updates
      clearTimeout(watchTimeout);
      watchTimeout = setTimeout(() => {
        // Dispatch custom event for file changes
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('webcontainer-fs-change', {
            detail: { event, filename, container }
          }));
        }
      }, 250);
    });

    return container;
  }

  static async saveProjectState(projectId: string): Promise<void> {
    if (!this.instance) return;

    try {
      await indexedDBStorage.saveProjectState(projectId, this.instance);
    } catch (error) {
      console.warn('Failed to save project state:', error);
    }
  }

  static async loadProjectState(projectId: string): Promise<Record<string, unknown> | null> {
    try {
      return await indexedDBStorage.loadProjectState(projectId);
    } catch (error) {
      console.warn('Failed to load project state:', error);
      return null;
    }
  }


  static async restoreFiles(container: WebContainer, files: Record<string, unknown>): Promise<void> {
    await indexedDBStorage.restoreFiles(container, files as Record<string, { type: string; content?: string }>);
  }

  static destroy(): void {
    this.instance = null;
    this.isBooting = false;
    this.bootPromise = null;
  }
}