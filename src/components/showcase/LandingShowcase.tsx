"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ShowcaseCard, type ShowcaseProject } from "./ShowcaseCard";

export function LandingShowcase() {
  const [projects, setProjects] = useState<ShowcaseProject[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/public/projects?sort=top&limit=6");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setProjects(body.projects ?? []);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (projects === null) {
    // initial loading placeholder — keep the same visual rhythm
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="aspect-[4/3] rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className="aspect-[4/3] rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] flex items-center justify-center text-[var(--sand-text-muted)] text-sm"
          >
            Be the first to publish
          </div>
        ))}
      </div>
    );
  }

  const featured = projects.slice(0, 3);

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
        {featured.map((p) => (
          <ShowcaseCard key={p.id} project={p} compact />
        ))}
      </div>
      <div className="mt-8 flex justify-center">
        <Link
          href="/explore"
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-4 py-2 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
        >
          Explore all projects
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
