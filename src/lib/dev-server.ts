import { WebContainer } from '@webcontainer/api';
import { WebContainerManager } from '@/lib/webcontainer';
import { sanitizeOutput } from '@/lib/output-sanitizer';

type Proc = {
  kill: () => void;
  output: ReadableStream<string>;
  input: WritableStream<string>;
  exit: Promise<number>;
};

class DevServerManagerImpl {
  private process: Proc | null = null;
  private logs: string[] = [];
  private maxLines = 2000;
  private startedByTool = false;
  private platform: 'web' | 'mobile' | 'multiplatform' | null = null;
  private ready = false;
  private initialized = false;

  private append(data: string) {
    // Sanitize the output to remove UUIDs and clean up display
    const cleaned = sanitizeOutput(data);

    // Split into lines and append
    const parts = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const line of parts) {
      if (line.length === 0) continue;
      this.logs.push(line);
    }
    if (this.logs.length > this.maxLines) {
      this.logs.splice(0, this.logs.length - this.maxLines);
    }
  }

  async detectPlatform(container: WebContainer): Promise<'web' | 'mobile' | 'multiplatform'> {
    if (this.platform) return this.platform;
    try {
      const pkgRaw = await container.fs.readFile('/package.json', 'utf8');
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['nativewind'] && deps['expo']) {
        // NativeWind + Expo = multiplatform (universal template)
        this.platform = 'multiplatform';
      } else if (deps['expo'] || deps['expo-router']) {
        this.platform = 'mobile';
      } else {
        this.platform = 'web';
      }
    } catch {
      this.platform = 'web';
    }
    return this.platform;
  }

  private async initContainerListeners(): Promise<void> {
    if (this.initialized) return;
    const container = await WebContainerManager.getInstance();
    container.on('server-ready', () => {
      this.ready = true;
    });
    container.on('port', (_port, type) => {
      if (type === 'close') {
        // When last port closes, consider server stopped
        this.ready = false;
        // Do not clear logs to allow tail after stop; they will roll over naturally
      }
    });
    this.initialized = true;
  }

  async isRunning(): Promise<boolean> {
    await this.initContainerListeners();
    if (this.process) return true;
    // If we have observed a server-ready event, consider it running
    if (this.ready) return true;
    return false;
  }

  /**
   * Start the dev server with optional environment variables
   * @param envVars - Environment variables to inject (e.g., VITE_CONVEX_URL)
   */
  async start(envVars?: Record<string, string>): Promise<{ ok: boolean; message: string; alreadyRunning?: boolean }> {
    await this.initContainerListeners();
    const container = await WebContainerManager.getInstance();

    // If we already have a process, report running
    if (this.process) {
      return { ok: true, message: 'Dev server already running', alreadyRunning: true };
    }

    // Detect if something is already running externally
    if (await this.isRunning()) {
      return { ok: true, message: 'Dev server already running (external)', alreadyRunning: true };
    }

    // Ensure deps installed by checking for node_modules
    try {
      await container.fs.readdir('/node_modules');
    } catch {
      // Not installed; run pnpm install
      try {
        const install = await container.spawn('pnpm', ['install']);
        const code = await install.exit;
        if (code !== 0) {
          return { ok: false, message: `Dependency install failed with code ${code}` };
        }
      } catch (e) {
        return { ok: false, message: `Dependency install failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // Start server based on platform
    const platform = await this.detectPlatform(container);

    // Build spawn options with environment variables
    const spawnOptions = envVars && Object.keys(envVars).length > 0
      ? { env: envVars }
      : undefined;

    try {
      const proc = (platform === 'mobile' || platform === 'multiplatform')
        ? await container.spawn('pnpm', ['exec', 'expo', 'start', '--web'], spawnOptions)
        : await container.spawn('pnpm', ['dev'], spawnOptions);

      this.process = proc as unknown as Proc;
      this.startedByTool = true;
      this.ready = false;

      // Stream output to buffer
      (async () => {
        try {
          const reader = proc.output.getReader();
          let buf = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              buf += value;
              // Push in chunks by lines
              const lastNl = buf.lastIndexOf('\n');
              if (lastNl >= 0) {
                this.append(buf.slice(0, lastNl));
                buf = buf.slice(lastNl + 1);
              }
              // Mark ready heuristically when vite announces or expo prints URL
              if (!this.ready && (/Local:\s+http:\/\//i.test(value) || /ready in \d+ ms/i.test(value) || /exp:\/\//i.test(value))) {
                this.ready = true;
              }
              // Detect Expo URL and broadcast
              const match = value.match(/(exp:\/\/[^\s]+)/);
              if (match && match[1] && typeof window !== 'undefined') {
                const raw = match[1];
                const clean = raw
                  .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
                  .replace(/[^\x20-\x7E]+$/g, '');
                window.dispatchEvent(new CustomEvent('devserver-exp-url', { detail: { url: clean } }));
              }
            }
          }
          if (buf) this.append(buf);
        } catch (e) {
          this.append(`[dev-log] reader error: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();

      // Do not await exit here; keep running
      return { ok: true, message: 'Dev server starting...' };
    } catch (e) {
      return { ok: false, message: `Failed to start dev server: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  getLog(linesBack: number): { ok: boolean; message: string; log?: string } {
    if (!Number.isFinite(linesBack) || linesBack <= 0) linesBack = 200;
    const count = Math.min(this.logs.length, Math.floor(linesBack));
    if (count === 0) {
      return {
        ok: false,
        message:
          this.process || this.ready
            ? 'Dev server log capture is not available (server likely started outside the tool). You can restart via startDevServer to capture logs, or check the UI console.'
            : 'No dev server log available. If the server is not running, start it with the startDevServer tool.'
      };
    }
    const slice = this.logs.slice(this.logs.length - count);
    return { ok: true, message: `Last ${count} line(s)`, log: slice.join('\n') };
  }

  async stop(): Promise<{ ok: boolean; message: string; alreadyStopped?: boolean }> {
    await this.initContainerListeners();
    const container = await WebContainerManager.getInstance();
    let any = false;
    try {
      if (this.process) {
        this.process.kill();
        this.process = null;
        this.startedByTool = false;
        any = true;
      }
    } catch {}

    // Attempt broader cleanup for processes that may not be tracked
    const killCommands: [string, string[]][] = [
      ['pkill', ['-f', 'vite']],
      ['pkill', ['-f', 'node.*dev']],
      ['pkill', ['-f', 'pnpm.*dev']],
      ['pkill', ['-f', 'expo']],
      ['pkill', ['-f', ':5173']],
    ];
    for (const [cmd, args] of killCommands) {
      try {
        await container.spawn(cmd, args);
        any = true;
      } catch {
        // ignore
      }
    }
    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 100));
    this.ready = false;
    return any
      ? { ok: true, message: 'Dev server stopped.' }
      : { ok: false, message: 'No dev server processes were running.', alreadyStopped: true };
  }
}

export const DevServerManager = new DevServerManagerImpl();
