import { isBetaUser } from "@/lib/tier";

/**
 * Swift's Xcode build + iPhone simulator runtime is beta-only and NOT yet
 * hardened. Gating project *creation* is not a security boundary: Swift was
 * historically creatable by anyone while the global NEXT_PUBLIC_ALLOW_PERSISTENT_EXP
 * flag was on, so non-beta users can still own legacy `platform === 'swift'`
 * projects. Every request that can reach the Swift runtime must call this — the
 * trust boundary lives at the runtime endpoints, not at creation.
 *
 * Returns true when access must be DENIED. Non-Swift projects always pass
 * (returns false without a Clerk/Redis lookup), so `sandboxed-web` — the default
 * platform for every user — is completely unaffected and pays zero overhead.
 *
 * Beta status is resolved via {@link isBetaUser}, which is Redis-cached (60s),
 * so the per-request cost for a Swift project is a single cache hit.
 */
export async function swiftRuntimeForbidden(
  platform: string,
  userId: string,
): Promise<boolean> {
  if (platform !== "swift") return false;
  return !(await isBetaUser(userId));
}
