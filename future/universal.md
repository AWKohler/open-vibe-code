# "Universal" (React Native web + mobile) — saved for later revival

Botflow once had **`mobile`** and **`multiplatform`** ("Universal") project platforms
alongside web/swift. They were WebContainer-era and are removed during the
WebContainer deprecation, but the intent is to bring Universal back (RN web +
mobile) on Vercel sandboxes. This captures what existed so it can be rebuilt.

## What they were
- `projects.platform` values `'mobile'` and `'multiplatform'`, gated behind
  `NEXT_PUBLIC_ALLOW_MOBILE_EXP` (`isMobilePlatformsEnabled()` in
  `src/lib/project-platform.ts`). `multiplatform` was labeled **"Universal"**,
  `mobile` was "Mobile App (Experimental)".
- Homepage platform toggle cycled web ↔ swift ↔ mobile ↔ multiplatform with
  `Smartphone`/`Monitor`/`Laptop` icons (`src/app/page.tsx`).
- Explore/showcase/projects cards rendered Mobile/Universal icons + labels.

## Agent system prompts (the valuable part)
The behavioral specs lived in `src/lib/agent/prompts.ts` as
**`SYSTEM_PROMPT_MOBILE`** and **`SYSTEM_PROMPT_MULTIPLATFORM`** (large exported
string constants), selected in `src/app/api/agent/route.ts` by platform. They
describe the RN/Expo project structure, available tools, and conventions.
→ Recover the exact text from git history (they remain in `prompts.ts` until the
agent-route/prompt cleanup; otherwise check before that commit).

## How to revive on Vercel sandboxes
1. Re-add the platform value(s) to `ProjectPlatform` + `getEnabledProjectPlatforms`
   (flag-gated, like swift) in `src/lib/project-platform.ts`.
2. Add an RN/Expo **sandbox template** repo to `TEMPLATE_REPOS` in
   `src/lib/vercel-sandbox.ts` and wire `pickSandboxTemplate`.
3. Route the platform to a sandbox workspace (model the persistent/swift path in
   `isolation-guard.tsx` + `persistent-workspace`), and restore the system prompt.
4. Re-add the homepage toggle affordance + card labels.

Everything here is reconstructable from git history; this file is the index/pointer.
