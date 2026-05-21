export type ProjectPlatform = "web" | "swift" | "sandboxed-web" | "mobile" | "multiplatform";

export function isSwiftPlatformEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_PERSISTENT_EXP === "true";
}

export function isSandboxedWebPlatformEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_SANDBOXED_WEB_EXP === "true";
}

export function isMobilePlatformsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_MOBILE_EXP === "true";
}

/** Returns true for any platform that runs in a Vercel sandbox (not a WebContainer). */
export function isSandboxPlatform(platform: string): boolean {
  return platform === "swift" || platform === "sandboxed-web";
}

export function getEnabledProjectPlatforms(): ProjectPlatform[] {
  const platforms: ProjectPlatform[] = ["web"];

  if (isSwiftPlatformEnabled()) {
    platforms.push("swift");
  }

  if (isSandboxedWebPlatformEnabled()) {
    platforms.push("sandboxed-web");
  }

  if (isMobilePlatformsEnabled()) {
    platforms.push("multiplatform", "mobile");
  }

  return platforms;
}

export function isProjectPlatform(value: string): value is ProjectPlatform {
  return (
    value === "web" ||
    value === "swift" ||
    value === "sandboxed-web" ||
    value === "mobile" ||
    value === "multiplatform"
  );
}

export function normalizeProjectPlatform(
  platform: string | null | undefined,
): ProjectPlatform {
  if (platform === "swift" && isSwiftPlatformEnabled()) {
    return "swift";
  }

  if (platform === "sandboxed-web" && isSandboxedWebPlatformEnabled()) {
    return "sandboxed-web";
  }

  if ((platform === "mobile" || platform === "multiplatform") && isMobilePlatformsEnabled()) {
    return platform;
  }

  return "web";
}

export function getNextProjectPlatform(
  currentPlatform: ProjectPlatform,
): ProjectPlatform {
  const platforms = getEnabledProjectPlatforms();
  const currentIndex = platforms.indexOf(currentPlatform);

  if (currentIndex === -1) {
    return platforms[0] ?? "web";
  }

  return platforms[(currentIndex + 1) % platforms.length] ?? "web";
}

export function getProjectPlatformLabel(platform: string): string {
  switch (platform) {
    case "swift":
      return "Swift";
    case "sandboxed-web":
      return "Sandboxed Web";
    case "mobile":
      return "Mobile";
    case "multiplatform":
      return "Universal";
    case "web":
    default:
      return "Web";
  }
}

export function getProjectPlatformShortLabel(platform: string): string {
  switch (platform) {
    case "swift":
      return "Swift";
    case "sandboxed-web":
      return "Sandbox";
    case "mobile":
      return "Mobile";
    case "multiplatform":
      return "Multi";
    case "web":
    default:
      return "Web";
  }
}

export function isWebLikePlatform(platform: string): boolean {
  return platform === "web" || platform === "sandboxed-web";
}

/**
 * Backend type for a project.
 *  - 'platform' : Botflow-managed Convex backend (default for paid users)
 *  - 'user'     : User-owned Convex (BYOC) provisioned via OAuth
 *  - 'none'     : No backend at all — the project is a frontend-only app
 *                 (no /convex folder, no Database tab, no convexDeploy tool).
 */
export type BackendType = "platform" | "user" | "none";

export function isBackendType(value: string): value is BackendType {
  return value === "platform" || value === "user" || value === "none";
}

export function normalizeBackendType(
  value: string | null | undefined,
): BackendType {
  return value === "user" || value === "none" ? value : "platform";
}

/**
 * Whether a project (with the given backendType) uses Convex at all.
 * Returns false ONLY for `'none'`. Both `'platform'` and `'user'` use Convex.
 */
export function projectUsesConvex(
  backendType: string | null | undefined,
): boolean {
  return backendType !== "none";
}

export function getBackendTypeLabel(backendType: string): string {
  switch (backendType) {
    case "user":
      return "Bring Your Own Convex";
    case "none":
      return "No Backend";
    case "platform":
    default:
      return "Botflow Managed";
  }
}
