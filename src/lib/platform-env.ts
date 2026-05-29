/**
 * Registry of platform-managed environment variables.
 *
 * These keys are owned by Botflow's own flows (Convex provisioning, Convex
 * Auth setup, the Google OAuth modal, the Stripe scaffold) — not by the user.
 * They must be IMMUTABLE through the generic Env panel so we never get a
 * split-brain between a dedicated UI (e.g. the OAuth modal) and a free-text
 * env editor.
 *
 * The panel renders reserved keys read-only with a "Managed by Botflow" badge;
 * the API routes reject any create/update/delete targeting them.
 *
 * `scope` tells the UI which section the var belongs to:
 *   - "frontend" → lives in /vercel/sandbox/.env (Vite, inlined at build)
 *   - "backend"  → lives on the Convex deployment (server-only secret)
 */
export interface ReservedEnvVar {
  key: string;
  scope: "frontend" | "backend";
  /** Short human label for the "why is this locked" tooltip. */
  managedBy: string;
}

export const RESERVED_ENV_VARS: ReservedEnvVar[] = [
  // Frontend → wires the Vite app to its Convex backend.
  { key: "VITE_CONVEX_URL", scope: "frontend", managedBy: "Convex backend" },
  { key: "EXPO_PUBLIC_CONVEX_URL", scope: "frontend", managedBy: "Convex backend" },

  // Backend → Convex Auth (set by convex-auth-setup.ts).
  { key: "JWT_PRIVATE_KEY", scope: "backend", managedBy: "Convex Auth" },
  { key: "CONVEX_AUTH_PRIVATE_KEY", scope: "backend", managedBy: "Convex Auth" },
  { key: "JWKS", scope: "backend", managedBy: "Convex Auth" },
  { key: "SITE_URL", scope: "backend", managedBy: "Convex Auth" },

  // Backend → Google OAuth (set by the sign-in setup modal).
  { key: "AUTH_GOOGLE_ID", scope: "backend", managedBy: "Google sign-in setup" },
  { key: "AUTH_GOOGLE_SECRET", scope: "backend", managedBy: "Google sign-in setup" },

  // Backend → Stripe scaffold.
  { key: "BOTFLOW_PROJECT_ID", scope: "backend", managedBy: "Stripe integration" },
  { key: "BOTFLOW_STRIPE_PROXY_BASE", scope: "backend", managedBy: "Stripe integration" },
  { key: "BOTFLOW_STRIPE_WEBHOOK_SECRET", scope: "backend", managedBy: "Stripe integration" },
  { key: "STRIPE_MODE", scope: "backend", managedBy: "Stripe integration" },

  // Backend → provided automatically by Convex itself; cannot be set.
  { key: "CONVEX_SITE_URL", scope: "backend", managedBy: "Convex" },
];

const RESERVED_BY_KEY = new Map(
  RESERVED_ENV_VARS.map((v) => [v.key.toUpperCase(), v] as const),
);

/** True when a key is platform-managed and must not be user-editable. */
export function isReservedEnvKey(key: string): boolean {
  return RESERVED_BY_KEY.has(key.trim().toUpperCase());
}

/** Lookup metadata for a reserved key (or undefined if it's a normal user var). */
export function getReservedEnvVar(key: string): ReservedEnvVar | undefined {
  return RESERVED_BY_KEY.get(key.trim().toUpperCase());
}
