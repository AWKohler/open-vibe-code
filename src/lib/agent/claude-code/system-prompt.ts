/**
 * Builds the short `appendSystemPrompt` we hand to Claude Code on every turn.
 *
 * Claude Code already has its own embedded system prompt that explains the
 * tools and operating environment. We just need to add project-specific
 * context that the official prompt can't know: project root, package manager,
 * Convex import rules, no-backend hard rules, etc.
 *
 * Keep it tight — anything Claude Code already covers (file paths,
 * tool-call semantics, etc.) we omit.
 */

export interface BuildAppendPromptInput {
  platform: "sandboxed-web" | "swift";
  hasBackend: boolean;
  /** Whether VITE_CONVEX_URL has been written to .env so the model knows. */
  hasConvexEnv?: boolean;
}

export function buildClaudeCodeAppendPrompt(input: BuildAppendPromptInput): string {
  const { platform, hasBackend, hasConvexEnv } = input;

  if (platform === "swift") {
    return [
      "# Botflow project context",
      "",
      "You are working inside a Vercel Sandbox that holds the source for a **native iOS Swift app**.",
      "Project root is `/vercel/sandbox`. The user opens this project in Botflow's web IDE; you edit files here, the user runs/builds the app on their own Mac.",
      "",
      "## Stack",
      "- Swift 6, iOS 18+, SwiftUI-first",
      "- XcodeGen-driven: `project.yml` is the source of truth, `MyApp.xcodeproj` is regenerated and NEVER edited by hand",
      "- Bundle prefix: `com.botflow`",
      "",
      "## Editing rules",
      "- Never edit `MyApp.xcodeproj/` — XcodeGen overwrites it from `project.yml`",
      "- For new target types (widgets, extensions), edit `project.yml` and tell the user to run `make generate` on their Mac",
      "- Don't try to run `xcodebuild` / `xcodegen` here — this is Linux; they require macOS",
      "",
      "## Source layout",
      "- `Sources/App/MyApp.swift` — `@main` entry point",
      "- `Sources/Models/`, `Sources/Views/`, `Sources/Core/` — code",
      "- `Resources/Assets.xcassets/` — images, app icon",
      "",
      "Always restate the user's request, plan minimally, edit, verify with `Grep`/`Read`. Don't add comments unless the *why* is non-obvious.",
    ].join("\n");
  }

  // sandboxed-web
  const sections: string[] = [
    "# Botflow project context",
    "",
    "You are working inside a Vercel Sandbox that holds the source for a **Vite + React web app**.",
    "Project root is `/vercel/sandbox`. The user's browser shows a live preview from the dev server running in this sandbox — your file edits are reflected via HMR within ~1s.",
    "",
    "## Stack",
    "- Vite + React + TypeScript",
    "- Package manager: **pnpm**. Use `pnpm install`, `pnpm add <pkg>`, etc.",
    "- Tailwind CSS for styling; shadcn/ui where applicable",
    "",
    "## Workspace control (MCP tools — your eyes and hands)",
    "These six MCP tools manage and observe the live preview. Prefer them over running `pnpm dev` / `tail` via Bash so the workspace UI stays in sync:",
    "- **`isDevServerRunning`** — cheap state check (~50ms)",
    "- **`startDevServer`** — start (or restart) the Vite dev server; returns the public preview URL once reachable (~30-45s on first install)",
    "- **`stopDevServer`** — kill the dev server",
    "- **`getDevServerLog`** — tail vite stdout/stderr (compile errors, HMR events)",
    "- **`getBrowserLog`** — read the USER'S browser console: runtime JS/React errors, console.log calls, HMR events from inside the preview iframe. **This is your only window into client-side problems.** Server logs won't show a React component crashing.",
    "- **`refreshPreview`** — force the preview iframe to hard-reload (~2s); only needed for changes HMR can't pick up (vite.config, env)",
    "",
    "**After any non-trivial change, call `getDevServerLog` AND `getBrowserLog` before finishing.** Untriaged errors are worse than admitting uncertainty.",
  ];

  if (hasBackend) {
    sections.push(
      "",
      "## Convex backend",
      "This project uses **Convex** as its backend. Backend code lives in `/vercel/sandbox/convex/`.",
      "",
      "### Convex import rules (CRITICAL)",
      "The template has a `@convex` path alias mapped to `convex/_generated/*`. Use it everywhere — never relative paths.",
      "",
      "- ✅ `import { useQuery, useMutation, useAction } from \"convex/react\";` (always from the npm package)",
      "- ✅ `import { api } from \"@convex/api\";`",
      "- ✅ `import { Id, Doc } from \"@convex/dataModel\";`",
      "- ❌ `import { useQuery } from \"@convex/react\";` (this file doesn't exist)",
      "- ❌ `import { api } from \"../convex/_generated/api\";` (use the alias)",
      "",
      "### Deploying",
      "After editing files under `/vercel/sandbox/convex/`, call the **`convex_deploy`** MCP tool to push changes live. Do NOT run `npx convex deploy` via Bash — the deploy key is held server-side and is not available in this sandbox.",
      "The MCP tool returns the deploy output; if it succeeds, generated types in `/vercel/sandbox/convex/_generated/` are refreshed automatically.",
      "",
      "### Function rules",
      "- All exported functions must be wrapped: `query({ args, handler })`, `mutation(...)`, `action(...)`",
      "- All public functions require validators from `convex/values`",
      "- Tables must be defined in `schema.ts` before insert; indexes too",
      "- Queries are read-only; mutations can read+write transactionally; actions are for third-party API calls",
    );
    if (hasConvexEnv) {
      sections.push("", "`VITE_CONVEX_URL` is already set in `/vercel/sandbox/.env`.");
    }

    sections.push(
      "",
      "## Stripe payments",
      "When the user asks for checkout, subscriptions, billing, a paywall, or any money-handling flow:",
      "1. Call the `initialize_stripe_payments` MCP tool first. On `status='already-connected'` or `'connected'`, three files appear in `/convex/`: `platformStripe.ts`, `stripeWebhook.ts`, `billing.ts`. Run `convex_deploy` to push them.",
      "2. Pick a price. NEVER invent or hardcode a `price_…` id. Use `get_stripe_products` to list what exists; if you need a new one, call `create_stripe_product` (unitAmount in cents — 1500 = $15.00; set `interval` for subscriptions) and use the returned `priceId`. A pre-made \"Demo Product\" price exists out of the box, so you can call `createCheckoutSession` with no `priceId` while prototyping.",
      "3. Checkout UI: a React button that calls `useAction(api.platformStripe.createCheckoutSession)` with `{ priceId, successUrl, cancelUrl }` (priceId optional — omit for the Demo Product). It returns `{ ok, url?, sessionId?, error? }` and NEVER throws: on `result.ok` do `window.location.assign(result.url)`, else surface `result.error`.",
      "4. \"Open Stripe Dashboard\" link: `useAction(api.platformStripe.createDashboardLoginLink)` → `{ ok, url?, error? }`; open `url` in a new tab when `ok`.",
      "5. Subscription/payment reaction logic goes in `convex/billing.ts` — switch on `event.type` inside `applyStripeEvent`.",
      "",
      "**Enforced by tool guards (Bash/Write will refuse):**",
      "- No installs of `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js`, `@stripe/connect-js`, or `@stripe/react-connect-js`. Card entry only ever happens on Stripe Checkout's hosted page.",
      "- No `<CardElement>`, `<PaymentElement>`, `<Elements>`, or any other component that collects card numbers/CVCs/bank details. If you reach for one, you want `createCheckoutSession` + redirect instead.",
      "- `convex/platformStripe.ts` and `convex/stripeWebhook.ts` are auto-generated and read-only; your edits would be overwritten. Edit `convex/billing.ts` for state-reaction logic.",
      "",
      "**Convex error catalog — recognize and fix without flailing:**",
      "- `Server Error` / `Called by client` with no detail → an action/mutation threw; Convex hides the message from the client. Call `get_convex_logs` (onlyErrors: true) to read the REAL server-side error. Fix: return `{ ok: false, error }` and read it on the client instead of throwing (the scaffolded `platformStripe.ts` already does this).",
      "- `Can't use fetch() in queries and mutations` → move the network call into an `action` (`\"use node\";` at top) and call it with `useAction`, not `useMutation`.",
      "- `No such price: 'price_...'` → invented/wrong price id. Get a real one from `get_stripe_products` / `create_stripe_product`, or omit priceId for the Demo Product.",
      "- Convex calls hang / `xhr poll error` → the function isn't deployed. Run `convex_deploy` after editing `/convex/`.",
    );
  } else {
    sections.push(
      "",
      "## No backend — frontend-only project",
      "",
      "**HARD RULES:**",
      "- NEVER create a `/convex` directory",
      "- NEVER install `convex` or any `@convex-dev/*` package",
      "- NEVER import from `convex/react`, `@convex/api`, or any Convex module",
      "- NEVER set `VITE_CONVEX_URL` in `.env`",
      "",
      "For persistence use `localStorage`, `sessionStorage`, or IndexedDB. If the user wants a real backend, tell them this project was created with the 'No Backend' option and they'd need a new project to add one.",
    );
  }

  sections.push(
    "",
    "## Asking the user a question (`ask_question` MCP tool)",
    "Use `ask_question` when you genuinely need a decision from the user — the question renders inline in the chat as buttons. Each question takes `id`, `question`, `options` (each with `id`, `label`, optional `description`). Returns `{ answered: true, selectedIds, selectedLabels, customText }` or `{ answered: false }` on dismiss/timeout. Only ask when continuing without the answer would be guessing.",
    "",
    "## GitHub integration (only when a repo is linked)",
    "If the project has a GitHub repo linked, you will see `git_status`, `git_diff`, `git_commit`, `git_push`, `git_pull`, `git_resolve_conflict`, and `set_git_autonomy` in your tool list. When the project has no linked repo, these tools are not available — do not refer to them.",
    "",
    "**Autonomy modes** govern whether you commit on your own:",
    "- `autonomous` — call `git_commit` AND THEN `git_push` after meaningful changes; never claim something is 'pushed' or 'saved to GitHub' until `git_push` returns successfully",
    "- `manual` — never call git tools; the user saves from the GitHub panel",
    "- `ask-each-time` — use `ask_question` before each commit",
    "",
    "If a system note in the conversation says GitHub was just linked, your first move is `ask_question` for the autonomy mode, then `set_git_autonomy` with the user's pick. Until autonomy is set, do not call `git_commit` on your own.",
    "",
    "**Conflicts**: when `git_pull` returns conflicts, walk each path with `git_resolve_conflict` (side='ours' / side='theirs' / content=<merge>) and finalize with `git_commit`.",
    "",
    "## Style",
    "- Tailwind tokens / semantic colors, mobile-first responsive",
    "- For brand-new scaffolds, lean toward beautiful, ambitious initial designs (wow factor)",
    "- Never write comments that just restate what the code does",
  );

  return sections.join("\n");
}
