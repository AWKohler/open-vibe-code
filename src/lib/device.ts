/**
 * Detect whether the current device supports the WebContainer-based workspace.
 *
 * Unsupported:
 *  - Any iOS device (iPhone, iPad) — WebContainers don't work in mobile Safari
 *  - Android phones — screen too small
 *
 * Supported:
 *  - Desktop browsers
 *  - Android tablets (best-effort)
 */

export type DeviceSupport = {
  supported: boolean;
  reason?: string;
};

export function checkDeviceSupport(): DeviceSupport {
  if (typeof navigator === 'undefined') {
    return { supported: true }; // SSR — assume supported
  }

  const ua = navigator.userAgent;

  // iOS detection (iPhone, iPad, iPod) — includes iPadOS which reports as Mac
  const isIOS =
    /iPhone|iPod/.test(ua) ||
    (/iPad/.test(ua)) ||
    // iPadOS 13+ reports as Macintosh but has touch
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (isIOS) {
    return {
      supported: false,
      reason: 'Botflow requires WebContainer technology that is not available on iOS devices. Please use a desktop browser.',
    };
  }

  // Android detection
  const isAndroid = /Android/.test(ua);
  if (isAndroid) {
    // Heuristic: Android tablets typically have wider screens (≥768px)
    const isTablet = Math.min(window.screen.width, window.screen.height) >= 768;
    if (!isTablet) {
      return {
        supported: false,
        reason: 'Botflow requires a larger screen to provide the full workspace experience. Please use a desktop browser or tablet.',
      };
    }
    // Android tablet — allow but with caveats
    return { supported: true };
  }

  return { supported: true };
}
