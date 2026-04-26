export type ProjectPlatform = "web" | "persistent" | "mobile" | "multiplatform";

export function isPersistentPlatformEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_PERSISTENT_EXP === "true";
}

export function isMobilePlatformsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_MOBILE_EXP === "true";
}

export function getEnabledProjectPlatforms(): ProjectPlatform[] {
  const platforms: ProjectPlatform[] = ["web"];

  if (isPersistentPlatformEnabled()) {
    platforms.push("persistent");
  }

  if (isMobilePlatformsEnabled()) {
    platforms.push("multiplatform", "mobile");
  }

  return platforms;
}

export function isProjectPlatform(value: string): value is ProjectPlatform {
  return (
    value === "web" ||
    value === "persistent" ||
    value === "mobile" ||
    value === "multiplatform"
  );
}

export function normalizeProjectPlatform(
  platform: string | null | undefined,
): ProjectPlatform {
  if (platform === "persistent" && isPersistentPlatformEnabled()) {
    return "persistent";
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
    case "persistent":
      return "Persistent";
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
    case "persistent":
      return "Persist";
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
  return platform === "web" || platform === "persistent";
}
