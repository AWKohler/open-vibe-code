"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { WebContainer } from "@webcontainer/api";
import { WebContainerManager } from "@/lib/webcontainer";
import { DevServerManager } from "@/lib/dev-server";
import { getPreviewStore, PreviewInfo } from "@/lib/preview-store";
import { useToast } from "@/components/ui/toast";
import JSZip from "jszip";
import { FileTree } from "./file-tree";
import { FileSearch } from "./file-search";
import { EnvPanel } from "./env-panel";
import { downloadRepoToWebContainer } from "@/lib/github";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { GitHubPanel } from "./github-panel";
import { PublishPanel } from "./publish-panel";
import { CodeEditor } from "./code-editor";
import { ImageViewer } from "./image-viewer";
import { TerminalTabs } from "./terminal-tabs";
import { Preview } from "./preview";
import { ConvexDashboard } from "@/components/convex/ConvexDashboard";
import { Button } from "@/components/ui/button";
import { Tabs, TabOption } from "@/components/ui/tabs";
import {
  PanelLeft,
  Save,
  RefreshCw,
  Play,
  Square,
  Loader2,
  ArrowUpRight,
  Monitor,
  Tablet,
  Smartphone,
  AppWindow,
  Frame,
  Github,
  Download,
} from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import "@/lib/debug-storage"; // Make debug utilities available in console

type WorkspaceView = "code" | "preview" | "database";

interface WorkspaceProps {
  projectId: string;
  initialPrompt?: string;
  platform?: "web" | "mobile";
}

export function Workspace({
  projectId,
  initialPrompt,
  platform: initialPlatform,
}: WorkspaceProps) {
  const [webcontainer, setWebcontainer] = useState<WebContainer | null>(null);
  const [files, setFiles] = useState<
    Record<string, { type: "file" | "folder" }>
  >({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [imageByteLength, setImageByteLength] = useState<number | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "env">("files");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentView, setCurrentView] = useState<WorkspaceView>("preview");
  const [previews, setPreviews] = useState<PreviewInfo[]>([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  // Preview UI state lifted to combine headers
  const [previewPath, setPreviewPath] = useState<string>("/");
  const [previewDevice, setPreviewDevice] = useState<
    "desktop" | "tablet" | "mobile" | "responsive" | "figma"
  >("desktop");
  const [previewLandscape] = useState(false);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [isDevServerRunning, setIsDevServerRunning] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [initializationComplete, setInitializationComplete] = useState(false);
  const [expUrl, setExpUrl] = useState<string | null>(null);
  const [platform, setPlatform] = useState<"web" | "mobile">(
    initialPlatform ?? "web",
  );
  const [cloudSyncStatus, setCloudSyncStatus] = useState<{
    syncing: boolean;
    lastSyncAt: Date | null;
  }>({ syncing: false, lastSyncAt: null });
  const [htmlSnapshotUrl, setHtmlSnapshotUrl] = useState<string | null>(null);

  // GitHub integration state
  const [githubRepoOwner, setGithubRepoOwner] = useState<string | null>(null);
  const [githubRepoName, setGithubRepoName] = useState<string | null>(null);
  const [githubDefaultBranch, setGithubDefaultBranch] = useState<string>("main");
  const [githubPanelOpen, setGithubPanelOpen] = useState(false);
  const githubBtnRef = useRef<HTMLButtonElement | null>(null);

  // Cloudflare Pages publish state
  const [cloudflareProjectName, setCloudflareProjectName] = useState<string | null>(null);
  const [cloudflareDeploymentUrl, setCloudflareDeploymentUrl] = useState<string | null>(null);
  const [publishPanelOpen, setPublishPanelOpen] = useState(false);
  const publishBtnRef = useRef<HTMLButtonElement | null>(null);
  const searchParams = useSearchParams();

  // Auto-open GitHub panel when returning from OAuth
  useEffect(() => {
    if (searchParams.get("github_connected") === "1") {
      setGithubPanelOpen(true);
      // Clean up URL param without reload
      const url = new URL(window.location.href);
      url.searchParams.delete("github_connected");
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  // Prevent concurrent initializations within same render
  const initializingRef = useRef(false);

  // Track which project was successfully initialized to prevent re-initialization loops
  const initializedProjectIdRef = useRef<string | null>(null);

  // Store preview subscription cleanup to persist across dependency changes
  const previewCleanupRef = useRef<(() => void) | undefined>(undefined);

  // Toast for notifications
  const { toast } = useToast();

  // Track if we've already captured HTML for this dev server session
  const htmlCapturedRef = useRef(false);

  // Fetch platform and htmlSnapshotUrl from API
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}`,
        );
        if (res.ok) {
          const proj = await res.json();
          if (
            !initialPlatform &&
            (proj?.platform === "mobile" || proj?.platform === "web")
          ) {
            setPlatform(proj.platform);
          }
          if (proj?.htmlSnapshotUrl) {
            setHtmlSnapshotUrl(proj.htmlSnapshotUrl);
          }
          if (proj?.githubRepoOwner) setGithubRepoOwner(proj.githubRepoOwner);
          if (proj?.githubRepoName) setGithubRepoName(proj.githubRepoName);
          if (proj?.githubDefaultBranch) setGithubDefaultBranch(proj.githubDefaultBranch);
          if (proj?.cloudflareProjectName) setCloudflareProjectName(proj.cloudflareProjectName);
          if (proj?.cloudflareDeploymentUrl) setCloudflareDeploymentUrl(proj.cloudflareDeploymentUrl);
        }
      } catch (e) {
        console.warn("Failed to load project data", e);
      }
    })();
  }, [initialPlatform, projectId]);

  // Helper function definitions - moved to top
  const getFileStructure = useCallback(
    async (
      container: WebContainer,
    ): Promise<Record<string, { type: "file" | "folder" }>> => {
      const files: Record<string, { type: "file" | "folder" }> = {};

      async function processDirectory(path: string) {
        try {
          const entries = await container.fs.readdir(path, {
            withFileTypes: true,
          });

          for (const entry of entries) {
            const fullPath =
              path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;

            if (entry.isDirectory()) {
              files[fullPath] = { type: "folder" };
              await processDirectory(fullPath);
            } else {
              files[fullPath] = { type: "file" };
            }
          }
        } catch (error) {
          console.error(`Error reading directory ${path}:`, error);
        }
      }

      await processDirectory("/");
      return files;
    },
    [],
  );

  const refreshFileTree = useCallback(
    async (container: WebContainer) => {
      const fileList = await getFileStructure(container);
      setFiles(fileList);
    },
    [getFileStructure],
  );

  const handleFileDrop = useCallback(
    async (targetFolder: string, transfer: DataTransfer) => {
      if (!webcontainer) return;

      const TEXT_EXTENSIONS = new Set([
        'txt', 'md', 'js', 'jsx', 'ts', 'tsx', 'json', 'html', 'htm', 'css',
        'scss', 'sass', 'less', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp',
        'h', 'hpp', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'xml', 'svg',
        'csv', 'env', 'gitignore', 'eslintrc', 'prettierrc', 'sql', 'graphql',
        'gql', 'vue', 'svelte', 'astro', 'php', 'swift', 'kt', 'dart', 'r',
        'tex', 'conf', 'ini', 'cfg', 'log', 'lock', 'editorconfig',
      ]);

      const isText = (name: string, mime: string) => {
        if (mime.startsWith('text/')) return true;
        if (['application/json', 'application/javascript', 'application/xml', 'image/svg+xml'].includes(mime)) return true;
        return TEXT_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');
      };

      const writeFile = async (path: string, file: File) => {
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir && dir !== '/') {
          await webcontainer.fs.mkdir(dir, { recursive: true }).catch(() => {});
        }
        const buf = await file.arrayBuffer();
        if (isText(file.name, file.type)) {
          await webcontainer.fs.writeFile(path, new TextDecoder().decode(buf));
        } else {
          await webcontainer.fs.writeFile(path, new Uint8Array(buf));
        }
      };

      const readAllEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
        new Promise((resolve, reject) => {
          const all: FileSystemEntry[] = [];
          const readBatch = () =>
            reader.readEntries((batch) => {
              if (batch.length === 0) resolve(all);
              else { all.push(...batch); readBatch(); }
            }, reject);
          readBatch();
        });

      const processEntry = async (entry: FileSystemEntry, base: string): Promise<void> => {
        const path = base ? `${base}/${entry.name}` : `/${entry.name}`;
        if (entry.isFile) {
          const file = await new Promise<File>((res, rej) =>
            (entry as FileSystemFileEntry).file(res, rej)
          );
          await writeFile(path, file);
        } else if (entry.isDirectory) {
          await webcontainer.fs.mkdir(path, { recursive: true }).catch(() => {});
          const entries = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
          for (const child of entries) await processEntry(child, path);
        }
      };

      try {
        const base = targetFolder === '/' ? '' : targetFolder;

        if (transfer.items.length > 0) {
          for (const item of Array.from(transfer.items)) {
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry?.();
            if (entry) {
              await processEntry(entry, base);
            } else {
              const file = item.getAsFile();
              if (file) await writeFile(`${base}/${file.name}`, file);
            }
          }
        } else {
          for (const file of Array.from(transfer.files)) {
            await writeFile(`${base}/${file.name}`, file);
          }
        }

        await refreshFileTree(webcontainer);
        toast({ title: 'Files imported', description: `Dropped into ${targetFolder === '/' ? 'project root' : targetFolder}` });
      } catch (err) {
        console.error('File drop failed:', err);
        toast({ title: 'Import failed', description: 'Could not write dropped files' });
      }
    },
    [webcontainer, refreshFileTree, toast],
  );

  const handleSaveFile = useCallback(async () => {
    if (!webcontainer || !selectedFile) return;

    try {
      await webcontainer.fs.writeFile(selectedFile, fileContent);
      setHasUnsavedChanges(false);
      console.log("File saved:", selectedFile);

      // Save project state
      await WebContainerManager.saveProjectState(projectId);

      // Refresh file tree to ensure it's in sync
      await refreshFileTree(webcontainer);
    } catch (error) {
      console.error("Failed to save file:", error);
    }
  }, [webcontainer, selectedFile, fileContent, projectId, refreshFileTree]);

  const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif',
  ]);
  const IMAGE_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    ico: 'image/x-icon', avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff',
  };

  const handleFileSelect = useCallback(
    async (filePath: string) => {
      if (!webcontainer || files[filePath]?.type !== "file") return;

      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

      // Revoke any previous blob URL to avoid memory leaks
      setImageBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
      setImageByteLength(undefined);

      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const buf = await webcontainer.fs.readFile(filePath); // returns Uint8Array
          const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
          const blob = new Blob([buf.buffer as ArrayBuffer], { type: mime });
          const url = URL.createObjectURL(blob);
          setSelectedFile(filePath);
          setFileContent('');
          setHasUnsavedChanges(false);
          setImageBlobUrl(url);
          setImageByteLength(buf.byteLength);
        } catch (error) {
          console.error("Failed to read image:", error);
        }
      } else {
        try {
          const content = await webcontainer.fs.readFile(filePath, "utf8");
          setSelectedFile(filePath);
          setFileContent(content);
          setHasUnsavedChanges(false);
        } catch (error) {
          console.error("Failed to read file:", error);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [webcontainer, files],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      setFileContent(newContent);
      setHasUnsavedChanges(fileContent !== newContent);
    },
    [fileContent],
  );

  // Removed unused handleRefreshFiles function

  const handleFileSystemChange = useCallback(
    async (event: Event) => {
      const { container } = (event as CustomEvent).detail;
      if (container) {
        await refreshFileTree(container);
        // Skip autosave while hydrating/init to avoid overwriting snapshots
        const { filename } = (event as CustomEvent).detail;
        if (
          !hydrating &&
          initializationComplete &&
          filename &&
          !filename.includes("node_modules") &&
          !filename.includes(".git")
        ) {
          console.log(
            `💾 Auto-saving project state (file changed: ${filename})...`,
          );
          await WebContainerManager.saveProjectState(projectId);
        } else {
          // Log why save was skipped
          if (hydrating) {
            console.log(
              `⏭️ Skipping auto-save: still hydrating (file: ${filename})`,
            );
          } else if (!initializationComplete) {
            console.log(
              `⏭️ Skipping auto-save: initialization not complete (file: ${filename})`,
            );
          } else if (!filename) {
            console.log(`⏭️ Skipping auto-save: no filename`);
          } else if (
            filename.includes("node_modules") ||
            filename.includes(".git")
          ) {
            console.log(`⏭️ Skipping auto-save: system file (${filename})`);
          }
        }
      }
    },
    [projectId, refreshFileTree, hydrating, initializationComplete],
  );

  const runInstall = useCallback(
    async (container: WebContainer) => {
      setIsInstalling(true);
      try {
        // Remove node_modules if it exists
        try {
          await container.fs.rm("/node_modules", {
            recursive: true,
            force: true,
          });
        } catch {
          // node_modules might not exist, that's ok
        }

        // Run installer based on platform
        const installProcess =
          platform === "mobile"
            ? await container.spawn("pnpm", ["install"])
            : await container.spawn("pnpm", ["install"]);
        const exitCode = await installProcess.exit;

        if (exitCode === 0) {
          setIsInstalled(true);
          console.log("install completed successfully");
        } else {
          console.error("install failed with exit code:", exitCode);
          setIsInstalled(false);
        }
      } catch (error) {
        console.error("Failed to run install:", error);
        setIsInstalled(false);
      } finally {
        setIsInstalling(false);
      }
    },
    [platform],
  );

  const startDevServer = useCallback(
    async (_container: WebContainer) => {
      // Keep UI flags similar, but delegate to DevServerManager
      if (!isInstalled) {
        await runInstall(_container);
      }
      setIsStartingServer(true);
      try {
        // Fetch environment variables from the API
        const envVars: Record<string, string> = {};
        try {
          const envResponse = await fetch(`/api/projects/${projectId}/env`);
          if (envResponse.ok) {
            const envData = await envResponse.json();
            // Add system env vars (like VITE_CONVEX_URL)
            for (const env of envData.systemEnvVars || []) {
              envVars[env.key] = env.value;
            }
            // Add user env vars
            for (const env of envData.envVars || []) {
              envVars[env.key] = env.value;
            }
            if (Object.keys(envVars).length > 0) {
              console.log(`Injecting ${Object.keys(envVars).length} environment variable(s)`);
            }
          }
        } catch (e) {
          console.warn("Failed to fetch env vars, starting without them:", e);
        }

        const res = await DevServerManager.start(envVars);
        console.log(res.message);
      } catch (error) {
        console.error("Failed to start dev server:", error);
      } finally {
        setIsStartingServer(false);
      }
    },
    [isInstalled, runInstall, projectId],
  );

  const stopDevServer = useCallback(async () => {
    try {
      console.log("🛑 Stopping dev server...");
      const res = await DevServerManager.stop();
      console.log(res.message);
      setExpUrl(null);
    } catch (error) {
      console.error("Failed to stop dev server:", error);
    }
  }, []);

  const handlePlayStopClick = useCallback(async () => {
    if (!webcontainer) return;

    if (isDevServerRunning) {
      await stopDevServer();
    } else {
      await startDevServer(webcontainer);
    }
  }, [webcontainer, isDevServerRunning, startDevServer, stopDevServer]);

  /**
   * Fetch a URL's HTML from inside the WebContainer.
   * This bypasses CORS because the request originates within the container
   * where the dev server is directly accessible on localhost.
   */
  const fetchHtmlViaWebContainer = useCallback(
    async (url: string): Promise<string> => {
      if (!webcontainer) throw new Error("WebContainer not ready");

      // Parse the URL to get the port and path
      const parsed = new URL(url);
      const port = parsed.port || "3000";
      const path = parsed.pathname + parsed.search;

      const tmpFile = "/tmp/__figma_capture_" + Date.now() + ".html";

      const proc = await webcontainer.spawn("node", [
        "-e",
        `const http = require("http");` +
          `const fs = require("fs");` +
          `http.get("http://localhost:${port}${path}", (res) => {` +
          `  let d = "";` +
          `  res.on("data", (c) => d += c);` +
          `  res.on("end", () => { fs.writeFileSync("${tmpFile}", d); process.exit(0); });` +
          `  res.on("error", (e) => { console.error(e); process.exit(1); });` +
          `}).on("error", (e) => { console.error(e); process.exit(1); });`,
      ]);

      const exitCode = await proc.exit;
      if (exitCode !== 0) {
        throw new Error(`WebContainer fetch failed (exit ${exitCode})`);
      }

      const html = await webcontainer.fs.readFile(tmpFile, "utf-8");
      // Clean up temp file (fire and forget)
      webcontainer.fs.rm(tmpFile).catch(() => {});
      return html;
    },
    [webcontainer],
  );

  const handleDownloadProject = useCallback(async () => {
    const container = webcontainer;
    if (!container) return;

    // Show loading toast
    toast({
      title: "Creating zip file...",
      description: "Please wait while we prepare your project files",
    });

    try {
      const zip = new JSZip();

      // Folders to exclude from the zip
      const excludedFolders = [
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
      ];

      // Recursively add files to zip
      async function addFilesToZip(
        container: WebContainer,
        path: string,
        zipFolder: JSZip,
      ) {
        try {
          const entries = await container.fs.readdir(path, {
            withFileTypes: true,
          });

          for (const entry of entries) {
            const fullPath =
              path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;

            // Skip excluded folders
            if (excludedFolders.includes(entry.name)) {
              continue;
            }

            if (entry.isDirectory()) {
              const newFolder = zipFolder.folder(entry.name);
              if (newFolder) {
                await addFilesToZip(container, fullPath, newFolder);
              }
            } else {
              // Read file content
              const content = await container.fs.readFile(fullPath, "utf8");
              zipFolder.file(entry.name, content);
            }
          }
        } catch (error) {
          console.error(`Error reading directory ${path}:`, error);
        }
      }

      // Start adding files from root
      await addFilesToZip(container, "/", zip);

      // Add .env.example file with environment variables
      try {
        const envResponse = await fetch(`/api/projects/${projectId}/env`);
        if (envResponse.ok) {
          const envData = await envResponse.json();
          const envLines: string[] = [];

          // Add header comment
          envLines.push("# Environment Variables");
          envLines.push("# Copy this file to .env and fill in your values");
          envLines.push("");

          // Add system env vars (like VITE_CONVEX_URL)
          for (const env of envData.systemEnvVars || []) {
            envLines.push(`${env.key}=${env.value}`);
          }

          // Add user env vars (placeholder values for secrets)
          for (const env of envData.envVars || []) {
            if (env.isSecret) {
              envLines.push(`${env.key}=your-value-here`);
            } else {
              envLines.push(`${env.key}=${env.value}`);
            }
          }

          // Only add file if there are env vars
          if (envData.systemEnvVars?.length > 0 || envData.envVars?.length > 0) {
            zip.file(".env.example", envLines.join("\n"));
          }
        }
      } catch (e) {
        console.warn("Failed to include .env.example in download:", e);
      }

      // Generate zip file
      const blob = await zip.generateAsync({ type: "blob" });

      // Create download link
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${projectId}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      // Show success toast
      toast({
        title: "Download complete",
        description: "Project files have been downloaded successfully",
      });
    } catch (error) {
      console.error("Failed to download project:", error);
      toast({
        title: "Download failed",
        description: "An error occurred while creating the zip file",
      });
    }
  }, [webcontainer, projectId, toast]);

  // REMOVED: Manual snapshot test button (no longer needed)

  useEffect(() => {
    async function initWebContainer() {
      // Prevent concurrent initializations within same mount
      if (initializingRef.current) {
        return;
      }

      // Prevent re-initialization if already completed successfully for this project
      if (initializedProjectIdRef.current === projectId) {
        return;
      }

      initializingRef.current = true;

      setHydrating(true);
      try {
        const container = await WebContainerManager.getInstance();
        setWebcontainer(container);

        // Initialize preview store
        const previewStore = getPreviewStore();
        previewStore.setWebContainer(container);

        // Subscribe to preview updates
        const unsubscribe = previewStore.subscribe((newPreviews) => {
          setPreviews((prevPreviews) => {
            // Auto-switch to preview tab when first server starts
            if (newPreviews.length > 0 && prevPreviews.length === 0) {
              setCurrentView("preview");
            }
            return newPreviews;
          });

          // Track if dev server is running
          setIsDevServerRunning(newPreviews.length > 0);
        });

        // Write .env file so Vite always has env vars regardless of who starts the server.
        // This is intentionally done on every workspace load so the file is always fresh.
        const writeEnvFile = async () => {
          try {
            const envResponse = await fetch(`/api/projects/${projectId}/env`);
            if (!envResponse.ok) return;
            const envData = await envResponse.json();
            const lines: string[] = [];
            for (const env of envData.systemEnvVars || []) {
              lines.push(`${env.key}=${env.value}`);
            }
            for (const env of envData.envVars || []) {
              lines.push(`${env.key}=${env.value}`);
            }
            if (lines.length > 0) {
              await container.fs.writeFile("/.env", lines.join("\n") + "\n");
            }
          } catch (e) {
            console.warn("Failed to write .env file:", e);
          }
        };

        // Always restore from saved state first; fall back to template if none (suppress autosave during init)
        console.log(`🔍 Loading project state for: ${projectId}`);
        const savedState =
          await WebContainerManager.loadProjectState(projectId);
        console.log(
          `📦 Saved state:`,
          savedState ? `${Object.keys(savedState).length} files` : "null",
        );

        if (savedState && Object.keys(savedState).length > 0) {
          console.log(
            `🔄 Restoring ${Object.keys(savedState).length} files from IndexedDB...`,
          );
          await WebContainerManager.restoreFiles(container, savedState);
          console.log(`✅ Files restored from IndexedDB`);
        } else {
          console.log(`📭 No local state found, trying cloud backup...`);

          // Try restoring from cloud (only for existing projects with backups)
          const { CloudBackupManager } = await import("@/lib/cloud-backup");
          const restored =
            await CloudBackupManager.getInstance().restoreFromCloud(
              projectId,
              container,
            );

          if (restored) {
            console.log("✅ Restored from cloud backup");
            await writeEnvFile();
            await refreshFileTree(container);
            setIsLoading(false);
            setHydrating(false);

            // Mark project as initialized to prevent re-initialization loop
            initializedProjectIdRef.current = projectId;

            // Store preview cleanup in ref to persist across dependency changes
            previewCleanupRef.current = unsubscribe;

            // Wait for pending fs.watch events before enabling auto-save
            setTimeout(() => {
              setInitializationComplete(true);
            }, 1000);

            // Return empty cleanup (preview cleanup is in ref)
            return;
          }

          // No backup found - mount template (normal for new projects)
          console.log(`📦 No backup found, mounting template...`);

          if (platform === "mobile") {
            // Download React Native + Convex template from GitHub
            console.log("📥 Downloading React Native + Convex template from GitHub...");
            await downloadRepoToWebContainer(container, {
              owner: "AWKohler",
              repo: "react-native-convex-template",
              ref: "main",
            });
            console.log("✅ Mobile template downloaded successfully");
          } else {
            // Download Vite + Convex template from GitHub
            console.log("📥 Downloading Vite+Convex template from GitHub...");
            await downloadRepoToWebContainer(container, {
              owner: "AWKohler",
              repo: "vite_convex_template",
              ref: "main",
            });
            console.log("✅ Template downloaded successfully");
          }
        }


        // Write .env with system/user env vars so Vite picks them up on every server start
        await writeEnvFile();

        // Get initial file list
        await refreshFileTree(container);

        setIsLoading(false);
        setHydrating(false);

        // Mark project as initialized to prevent re-initialization loop
        initializedProjectIdRef.current = projectId;

        // Store preview cleanup in ref to persist across dependency changes
        previewCleanupRef.current = unsubscribe;

        // Wait for any pending fs.watch events to complete before enabling auto-save
        // This prevents the initial template mount from triggering auto-save
        setTimeout(() => {
          setInitializationComplete(true);
        }, 1000);

        // Return empty cleanup (preview cleanup is in ref)
        return;
      } catch (error) {
        console.error("Failed to initialize WebContainer:", error);
        setIsLoading(false);
        setHydrating(false);

        // Mark project as initialized even on error to prevent re-initialization loop
        initializedProjectIdRef.current = projectId;

        setTimeout(() => {
          setInitializationComplete(true);
        }, 1000);
        return; // No cleanup needed
      }
    }

    initWebContainer();

    // Listen for file system changes
    window.addEventListener("webcontainer-fs-change", handleFileSystemChange);

    return () => {
      // Reset initialization guard so component can re-initialize on remount
      initializingRef.current = false;

      window.removeEventListener(
        "webcontainer-fs-change",
        handleFileSystemChange,
      );
    };
  }, [
    projectId,
    platform,
    refreshFileTree,
    handleFileSystemChange,
    runInstall,
  ]);

  // Cleanup preview subscription only when project changes or component unmounts
  useEffect(() => {
    return () => {
      if (previewCleanupRef.current) {
        previewCleanupRef.current();
        previewCleanupRef.current = undefined;
      }
      // Reset initialization state when project changes
      initializedProjectIdRef.current = null;
    };
  }, [projectId]);

  // Listen for agent busy state changes (for preview loading carousel)
  useEffect(() => {
    const onBusyChange = (e: Event) => {
      const busy = (e as CustomEvent).detail?.isBusy as boolean;
      setIsAgentBusy(busy);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("agent-busy-change", onBusyChange as EventListener);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("agent-busy-change", onBusyChange as EventListener);
      }
    };
  }, []);

  // React to preview refresh requests from tools
  useEffect(() => {
    const onRefresh = () => setPreviewReloadKey((k) => k + 1);
    const onExpoUrl = (e: Event) => {
      try {
        const url = (e as CustomEvent).detail?.url as string | undefined;
        if (url) setExpUrl(url);
      } catch {}
    };
    if (typeof window !== "undefined") {
      window.addEventListener("preview-refresh", onRefresh as EventListener);
      window.addEventListener("devserver-exp-url", onExpoUrl as EventListener);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(
          "preview-refresh",
          onRefresh as EventListener,
        );
        window.removeEventListener(
          "devserver-exp-url",
          onExpoUrl as EventListener,
        );
      }
    };
  }, []);

  // Listen for HTML snapshot messages from iframe
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // Security: Only accept messages from StackBlitz/WebContainer domains
      if (
        !event.origin.includes("stackblitz") &&
        !event.origin.includes("webcontainer")
      ) {
        return; // Silently ignore untrusted origins
      }

      // Forward iframe console messages to parent console AND capture in BrowserLogManager
      if (event.data?.type === "IFRAME_CONSOLE") {
        const { level, message } = event.data;
        const prefix = "[iframe]";
        if (level === "error") {
          console.error(prefix, message);
        } else if (level === "warn") {
          console.warn(prefix, message);
        } else {
          console.log(prefix, message);
        }

        // Capture in BrowserLogManager for agent access
        const { BrowserLogManager } = await import("@/lib/browser-log-manager");
        BrowserLogManager.addConsoleLog(
          level as "log" | "warn" | "error",
          message,
        );
        return;
      }

      // Forward iframe errors to parent console AND capture in BrowserLogManager
      if (event.data?.type === "IFRAME_ERROR") {
        const errorMsg = event.data.filename
          ? `${event.data.message} at ${event.data.filename}:${event.data.lineno}:${event.data.colno}`
          : event.data.message;
        console.error("[iframe error]", errorMsg);

        // Capture in BrowserLogManager for agent access
        const { BrowserLogManager } = await import("@/lib/browser-log-manager");
        BrowserLogManager.addError(errorMsg);
        return;
      }

      // Handle Vite HMR events AND capture in BrowserLogManager
      if (event.data?.type === "VITE_HMR") {
        const { event: hmrEvent, error } = event.data;
        if (hmrEvent === "connected") {
          console.log("🔌 [Vite HMR] Connected");
        } else if (hmrEvent === "disconnected") {
          console.warn("⚠️ [Vite HMR] Disconnected");
        } else if (hmrEvent === "error") {
          console.error("❌ [Vite HMR] Error:", error);
        } else if (hmrEvent === "beforeUpdate") {
          console.log("🔄 [Vite HMR] Updating...");
        } else if (hmrEvent === "afterUpdate") {
          console.log("✅ [Vite HMR] Updated");
        } else if (hmrEvent === "hmrModuleLoaded") {
          console.log("✅ [Vite HMR] Module loaded - HMR is available");
        } else if (hmrEvent === "hmrNotAvailable") {
          console.warn(
            "⚠️ [Vite HMR] Not available (import.meta.hot is undefined)",
          );
        }

        // Capture in BrowserLogManager for agent access
        const { BrowserLogManager } = await import("@/lib/browser-log-manager");
        BrowserLogManager.addHMREvent(hmrEvent, error);
        return;
      }

      // Handle React Error Boundary errors
      if (event.data?.type === "REACT_ERROR") {
        console.error("❌ [React Error]", event.data.message);
        if (event.data.stack) {
          console.error("Stack:", event.data.stack);
        }
        if (event.data.componentStack) {
          console.error("Component Stack:", event.data.componentStack);
        }
        return;
      }

      if (event.data?.type === "HTML_SNAPSHOT" && event.data?.html) {
        // Only capture once per dev server session
        if (htmlCapturedRef.current) {
          return; // Already captured, silently skip
        }

        try {
          console.log("📄 Received HTML snapshot from iframe!");
          const html = event.data.html;
          console.log(`📄 HTML size: ${html.length} bytes`);

          // Upload to UploadThing
          const response = await fetch(
            `/api/projects/${projectId}/html-snapshot`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ html }),
            },
          );

          if (!response.ok) {
            const error = await response.json();
            console.error("Failed to save HTML snapshot:", error);
            return;
          }

          const result = await response.json();
          console.log("✅ HTML snapshot saved:", result.htmlSnapshotUrl);

          // Generate thumbnail from HTML
          console.log("🖼️  Generating thumbnail from HTML...");
          const thumbnailResponse = await fetch(
            `/api/projects/${projectId}/generate-thumbnail-html`,
            {
              method: "POST",
            },
          );

          if (thumbnailResponse.ok) {
            const thumbnailResult = await thumbnailResponse.json();
            console.log(
              "✅ Thumbnail generated:",
              thumbnailResult.thumbnailUrl,
            );

            // Show toast notification
            toast({
              title: "Thumbnail saved",
              description: "Project snapshot captured successfully",
            });
          } else {
            console.error("Failed to generate thumbnail");
            // Still show toast for HTML snapshot
            toast({
              title: "Snapshot saved",
              description: "Thumbnail generation failed",
            });
          }

          htmlCapturedRef.current = true;
        } catch (error) {
          console.error("Failed to save HTML snapshot:", error);
        }
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [projectId, toast]);

  // Reset capture flag when dev server stops
  useEffect(() => {
    if (previews.length === 0) {
      htmlCapturedRef.current = false;
    }
  }, [previews]);

  // Listen for cloud sync events
  useEffect(() => {
    const handleSyncStart = () =>
      setCloudSyncStatus({ syncing: true, lastSyncAt: null });
    const handleSyncComplete = () =>
      setCloudSyncStatus({ syncing: false, lastSyncAt: new Date() });
    const handleSyncError = () =>
      setCloudSyncStatus((prev) => ({
        syncing: false,
        lastSyncAt: prev.lastSyncAt,
      }));

    if (typeof window !== "undefined") {
      window.addEventListener("cloud-sync-start", handleSyncStart);
      window.addEventListener("cloud-sync-complete", handleSyncComplete);
      window.addEventListener("cloud-sync-error", handleSyncError);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("cloud-sync-start", handleSyncStart);
        window.removeEventListener("cloud-sync-complete", handleSyncComplete);
        window.removeEventListener("cloud-sync-error", handleSyncError);
      }
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (selectedFile && hasUnsavedChanges) {
          handleSaveFile();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFile, hasUnsavedChanges, handleSaveFile]);

  // Auto-save on page unload
  useEffect(() => {
    const handleBeforeUnload = async (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
        event.returnValue = "";
        await handleSaveFile();
      }

      // Save project state on exit
      await WebContainerManager.saveProjectState(projectId);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges, projectId, handleSaveFile]);

  // Auto-save when switching files
  useEffect(() => {
    return () => {
      // This cleanup runs when selectedFile is about to change
      if (hasUnsavedChanges && webcontainer && selectedFile) {
        webcontainer.fs
          .writeFile(selectedFile, fileContent)
          .catch(console.error);
        WebContainerManager.saveProjectState(projectId).catch(console.error);
      }
    };
  }, [selectedFile, hasUnsavedChanges, webcontainer, projectId, fileContent]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg">
        {/* <div className="text-muted">Loading WebContainer...</div> */}
        <div className="text-muted">There is no moat...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bolt-bg text-fg">
      {/* Agent sidebar - persistent on the far left */}
      <div className="w-96 flex flex-col bg-elevated/70 backdrop-blur-sm">
        <AgentPanel
          className="h-full"
          projectId={projectId}
          initialPrompt={initialPrompt}
          platform={platform}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="h-12 flex items-center pr-2.5 gap-4 bg-surface backdrop-blur-sm">
          {/* Tabs */}
          <Tabs
            options={
              [
                {
                  value: "preview",
                  text: `Preview`,
                  // text: `Preview${
                  //   previews.length > 0 ? ` (${previews.length})` : ""
                  // }`,
                },
                { value: "code", text: "Code" },
                { value: "database", text: "Database" },
              ] as TabOption<WorkspaceView>[]
            }
            selected={currentView}
            onSelect={setCurrentView}
          />

          {/* Play/Stop Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePlayStopClick}
            disabled={isInstalling || isStartingServer}
            className={cn(
              "flex items-center gap-2 font-bold text-md",
              isDevServerRunning
                ? "text-red-400 hover:text-red-300 hover:bg-red-400/10"
                : "text-green-400 hover:text-green-300 hover:bg-green-400/10",
            )}
          >
            {isInstalling || isStartingServer ? (
              <Loader2 size={16} className="animate-spin" />
            ) : isDevServerRunning ? (
              <Square size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
            <span>
              {isInstalling
                ? "Installing..."
                : isStartingServer
                  ? "Starting..."
                  : isDevServerRunning
                    ? "Stop"
                    : "Start"}
            </span>
          </Button>

          {/* File explorer toggle - on the right side of Tabs and after Start/Stop */}
          {currentView === "code" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-muted hover:text-fg bolt-hover"
              title={showSidebar ? "Hide explorer" : "Show explorer"}
            >
              <PanelLeft size={16} />
            </Button>
          )}

          {currentView === "code" && selectedFile && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted">/</span>
              <span className="text-fg font-medium bg-elevated/70 px-2 py-1 rounded flex items-center gap-2">
                {selectedFile.split("/").pop()}
                {hasUnsavedChanges && (
                  <span
                    className="w-2 h-2 rounded-full bg-orange-500"
                    title="Unsaved changes"
                  />
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveFile}
                className="text-muted hover:text-fg bolt-hover"
                title="Save file"
              >
                <Save size={16} />
                <span className="ml-1">Save</span>
              </Button>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {currentView === "database" && (
              <button
                onClick={() => window.open(`/workspace/${projectId}/database`, "_blank")}
                className="flex items-center gap-1.5 text-sm text-muted hover:text-fg border border-border rounded-md px-3 py-1 bolt-hover"
                title="Open database in new tab"
              >
                <ArrowUpRight size={14} />
                Open in new tab
              </button>
            )}
            {currentView === "preview" && previews.length > 1 && (
              <select
                className="text-sm bg-elevated border border-border rounded-md px-2 py-1 text-muted"
                value={activePreviewIndex}
                onChange={(e) =>
                  setActivePreviewIndex(Number(e.target.value))
                }
                title="Select preview port"
              >
                {previews.map((p, i) => (
                  <option key={p.port} value={i}>
                    Port {p.port}
                  </option>
                ))}
              </select>
            )}

            {/* Cloud Sync Status Indicator */}
            <div className="text-xs text-muted flex items-center gap-1.5 px-2 py-1 rounded-md bg-elevated">
              {cloudSyncStatus.syncing ? (
                <>
                  <Loader2 size={12} className="animate-spin text-blue-500" />
                  <span>Syncing...</span>
                </>
              ) : cloudSyncStatus.lastSyncAt ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span>Synced {timeAgo(cloudSyncStatus.lastSyncAt)}</span>
                </>
              ) : null}
            </div>

            {currentView === "preview" && (
              <div className="flex items-center gap-2 border border-border rounded-full px-3 py-1 min-w-[220px]">
                {/* Device toggle: cycles desktop → tablet → mobile */}
                <button
                  onClick={() =>
                    setPreviewDevice((prev) =>
                      prev === "desktop"
                        ? "tablet"
                        : prev === "tablet"
                          ? "mobile"
                          : prev === "mobile"
                            ? "responsive"
                            : prev === "responsive"
                              ? "figma"
                              : "desktop",
                    )
                  }
                  className="text-muted hover:text-fg"
                  title={`Device: ${previewDevice}`}
                >
                  {previewDevice === "desktop" && <Monitor size={16} />}
                  {previewDevice === "tablet" && <Tablet size={16} />}
                  {previewDevice === "mobile" && <Smartphone size={16} />}
                  {previewDevice === "responsive" && <AppWindow size={16} />}
                  {previewDevice === "figma" && <Frame size={16} />}
                </button>
                <span className="text-muted text-sm select-none">/</span>
                <input
                  type="text"
                  value={previewPath.replace(/^\//, "")}
                  onChange={(e) =>
                    setPreviewPath("/" + e.target.value.replace(/^\//, ""))
                  }
                  placeholder=""
                  className="flex-1 bg-transparent text-sm outline-none"
                />
                <button
                  onClick={() => {
                    const p = previews[activePreviewIndex];
                    if (p) {
                      const previewUrl = p.baseUrl + (previewPath || "/");
                      window.open(
                        `/preview-popup?url=${encodeURIComponent(previewUrl)}`,
                        "_blank"
                      );
                    }
                  }}
                  className="text-muted hover:text-fg"
                  title="Open in new tab"
                >
                  <ArrowUpRight size={16} />
                </button>
                <button
                  onClick={() => setPreviewReloadKey((k) => k + 1)}
                  className="text-muted hover:text-fg"
                  title="Reload preview"
                >
                  <RefreshCw size={16} />
                </button>
              </div>
            )}

            <UserButton
              afterSignOutUrl="/"
              appearance={{ elements: { userButtonAvatarBox: "w-8 h-8" } }}
            />
            {currentView === "code" && (
              <Button
                variant="outline"
                size="sm"
                className="w-8 p-0 aspect-square"
                onClick={handleDownloadProject}
                title="Download project"
              >
                <Download size={16} />
              </Button>
            )}
            <div className="relative">
              <Button
                ref={githubBtnRef}
                variant="outline"
                size="sm"
                className={cn(
                  "w-8 p-0 aspect-square",
                  githubRepoOwner && githubRepoName && "border-green-500/50 text-green-600 dark:text-green-400"
                )}
                onClick={() => setGithubPanelOpen((v) => !v)}
                title={githubRepoOwner ? `GitHub: ${githubRepoOwner}/${githubRepoName}` : "Connect GitHub"}
              >
                <Github size={16} />
              </Button>
              {githubRepoOwner && githubRepoName && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500 border-2 border-surface pointer-events-none" />
              )}
              <GitHubPanel
                projectId={projectId}
                webcontainer={webcontainer}
                isOpen={githubPanelOpen}
                onClose={() => setGithubPanelOpen(false)}
                anchorRef={githubBtnRef}
                githubRepoOwner={githubRepoOwner}
                githubRepoName={githubRepoName}
                githubDefaultBranch={githubDefaultBranch}
                onRepoConnected={(owner, name, branch) => {
                  setGithubRepoOwner(owner);
                  setGithubRepoName(name);
                  setGithubDefaultBranch(branch);
                }}
                onRepoDisconnected={() => {
                  setGithubRepoOwner(null);
                  setGithubRepoName(null);
                  setGithubDefaultBranch("main");
                }}
              />
            </div>
            <div className="relative">
              <Button
                ref={publishBtnRef}
                variant="default"
                size="sm"
                className={cn(
                  "font-bold text-sm",
                  cloudflareDeploymentUrl && "bg-green-600 hover:bg-green-700 text-white"
                )}
                onClick={() => setPublishPanelOpen((v) => !v)}
              >
                {cloudflareDeploymentUrl ? "Published" : "Publish"}
              </Button>
              {cloudflareDeploymentUrl && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500 border-2 border-surface pointer-events-none" />
              )}
              <PublishPanel
                projectId={projectId}
                webcontainer={webcontainer}
                isOpen={publishPanelOpen}
                onClose={() => setPublishPanelOpen(false)}
                anchorRef={publishBtnRef}
                cloudflareProjectName={cloudflareProjectName}
                cloudflareDeploymentUrl={cloudflareDeploymentUrl}
                onPublished={(name, url) => {
                  setCloudflareProjectName(name);
                  setCloudflareDeploymentUrl(url);
                }}
                onUnpublished={() => {
                  setCloudflareProjectName(null);
                  setCloudflareDeploymentUrl(null);
                }}
              />
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 min-h-0 relative bg-surface">
          {/* Code View - Always mounted but conditionally visible */}
          <div
            className={cn(
              "absolute inset-0",
              currentView === "code" ? "flex flex-col" : "hidden",
              "rounded-xl border border-border overflow-hidden",
            )}
          >
            <div className="flex-1 min-h-0 flex">
              {showSidebar && (
                <div className="w-80 bolt-border border-r flex flex-col backdrop-blur-sm">
                  <div className="p-2 bolt-border border-b">
                    <Tabs
                      options={
                        [
                          { value: "files", text: "Files" },
                          { value: "search", text: "Search" },
                          { value: "env", text: "ENV" },
                        ] as TabOption<"files" | "search" | "env">[]
                      }
                      selected={sidebarTab}
                      onSelect={(v) => setSidebarTab(v as "files" | "search" | "env")}
                      stretch
                    />
                  </div>
                  <div className="flex-1 overflow-auto modern-scrollbar">
                    {sidebarTab === "files" ? (
                      <FileTree
                        files={files}
                        selectedFile={selectedFile}
                        onFileSelect={handleFileSelect}
                        onFileDrop={handleFileDrop}
                      />
                    ) : sidebarTab === "search" ? (
                      <FileSearch
                        files={files}
                        webcontainer={webcontainer}
                        onOpenFile={(path) => {
                          setCurrentView("code");
                          handleFileSelect(path);
                        }}
                      />
                    ) : (
                      <EnvPanel projectId={projectId} />
                    )}
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 relative">
                <div className="absolute inset-0 bg-elevated/90 backdrop-blur-sm">
                  {imageBlobUrl ? (
                    <ImageViewer
                      src={imageBlobUrl}
                      filename={selectedFile ?? ''}
                      byteLength={imageByteLength}
                    />
                  ) : (
                    <CodeEditor
                      value={fileContent}
                      onChange={handleContentChange}
                      language={getLanguageFromFilename(selectedFile || "")}
                      filename={selectedFile}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Terminal - Always mounted, persists across tab switches */}
            <div className="h-64 bolt-border border-t bg-elevated backdrop-blur-sm">
              <TerminalTabs webcontainer={webcontainer} />
            </div>
          </div>
          {/* Database View */}
          {currentView === "database" && (
            <div className="absolute inset-0 pb-2.5 pr-2.5">
              <div className="w-full h-full rounded-xl border border-border overflow-hidden">
                <ConvexDashboard projectId={projectId} />
              </div>
            </div>
          )}
          {/* Preview View - Always mounted but conditionally visible */}
          <div
            className={cn(
              "absolute inset-0 pb-2.5 pr-2.5",
              currentView === "preview" ? "block" : "hidden",
            )}
          >
            <Preview
              previews={previews}
              activePreviewIndex={activePreviewIndex}
              onActivePreviewChange={setActivePreviewIndex}
              showHeader={false}
              currentPath={previewPath}
              selectedDevice={previewDevice}
              isLandscape={previewLandscape}
              reloadKey={previewReloadKey}
              isDevServerRunning={isDevServerRunning}
              isInstalling={isInstalling}
              isStartingServer={isStartingServer}
              onToggleDevServer={handlePlayStopClick}
              platform={platform}
              expUrl={expUrl}
              htmlSnapshotUrl={htmlSnapshotUrl}
              isAgentWorking={isAgentBusy}
              onFetchHtml={fetchHtmlViaWebContainer}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    py: "python",
    rb: "ruby",
    php: "php",
    java: "java",
    cpp: "cpp",
    c: "c",
    go: "go",
    rs: "rust",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
  };

  return languageMap[ext || ""] || "plaintext";
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
