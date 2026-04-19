"use client";

import { useState } from "react";
import Link from "next/link";
import { Star, Laptop, Smartphone, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ShowcaseProject {
  id: string;
  name: string;
  platform: "web" | "mobile" | "multiplatform";
  publicSlug: string;
  publicDescription: string | null;
  thumbnailUrl: string | null;
  htmlSnapshotUrl: string | null;
  starCount: number;
  author: { name: string; imageUrl: string | null };
  hasStarred: boolean;
}

export function ShowcaseCard({ project, compact = false }: { project: ShowcaseProject; compact?: boolean }) {
  // thumbnailUrl is a PNG screenshot; htmlSnapshotUrl is an HTML doc and
  // must not be used as an <img> src. Match the projects page behavior.
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = project.thumbnailUrl;
  const Icon = project.platform === "mobile" ? Smartphone : project.platform === "multiplatform" ? Layers : Laptop;

  return (
    <Link
      href={`/p/${project.publicSlug}`}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-all duration-200",
        "hover:shadow-xl hover:-translate-y-0.5 hover:border-accent/30"
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-elevated to-bg">
        {thumb && !thumbFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt={project.name}
            onError={() => setThumbFailed(true)}
            className="w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted">
            <Icon className="h-10 w-10" />
          </div>
        )}

        {/* Subtle gradient overlay for legibility */}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

        {/* Platform chip */}
        <div className="absolute top-3 left-3">
          <span className="inline-flex items-center gap-1 rounded-full bg-surface/90 backdrop-blur-sm px-2 py-1 text-[11px] font-medium text-fg shadow-sm">
            <Icon className="h-3 w-3" />
            {project.platform === "web" ? "Web" : project.platform === "mobile" ? "Mobile" : "Universal"}
          </span>
        </div>

        {/* Stars chip */}
        {project.starCount > 0 && (
          <div className="absolute top-3 right-3">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full backdrop-blur-sm px-2 py-1 text-[11px] font-medium shadow-sm",
              project.hasStarred ? "bg-accent/90 text-[var(--sand-accent-contrast)]" : "bg-surface/90 text-fg"
            )}>
              <Star className={cn("h-3 w-3", project.hasStarred && "fill-current")} />
              {project.starCount}
            </span>
          </div>
        )}
      </div>

      <div className={cn("p-4 flex-1 flex flex-col", compact && "p-3")}>
        <h3 className="font-medium text-fg truncate" title={project.name}>
          {project.name}
        </h3>
        {project.publicDescription && !compact && (
          <p className="mt-1 text-xs text-muted line-clamp-2">{project.publicDescription}</p>
        )}
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          {project.author.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={project.author.imageUrl} alt="" className="h-5 w-5 rounded-full border border-border" />
          ) : (
            <div className="h-5 w-5 rounded-full bg-elevated border border-border" />
          )}
          <span className="truncate">{project.author.name}</span>
        </div>
      </div>
    </Link>
  );
}
