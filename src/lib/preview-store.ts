/**
 * Preview metadata shape shared by the workspace preview components.
 *
 * The old WebContainer-driven PreviewStore (port/server-ready event tracking)
 * was removed with the WebContainer deprecation — the sandbox workspaces manage
 * their own preview state and only consume this type.
 */
export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}
