'use client';

import { useState, useRef } from 'react';
import type { JSX } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FileNode {
  type: 'file' | 'folder';
  [key: string]: unknown;
}

interface FileTreeProps {
  files: Record<string, FileNode>;
  selectedFile: string | null;
  onFileSelect: (filePath: string) => void;
  onFileDrop?: (targetFolder: string, transfer: DataTransfer) => Promise<void>;
}

export function FileTree({ files, selectedFile, onFileSelect, onFileDrop }: FileTreeProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['/']));
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // Counter to correctly handle nested drag enter/leave events
  const dragCounter = useRef(0);

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  // ── Drag handlers ──────────────────────────────────────────────────────────

  const onContainerDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDraggingOver(true);
  };

  const onContainerDragLeave = (_e: React.DragEvent) => {
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDraggingOver(false);
      setDragOverFolder(null);
    }
  };

  const onContainerDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    // If nothing specific is highlighted, default to root
    if (!dragOverFolder) setDragOverFolder('/');
  };

  const onContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const target = dragOverFolder ?? '/';
    dragCounter.current = 0;
    setIsDraggingOver(false);
    setDragOverFolder(null);
    if (e.dataTransfer.items.length > 0 || e.dataTransfer.files.length > 0) {
      onFileDrop?.(target, e.dataTransfer);
    }
  };

  const onFolderDragEnter = (e: React.DragEvent, folderPath: string) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.stopPropagation();
    setDragOverFolder(folderPath);
    // Auto-expand the folder so user can navigate into subfolders while dragging
    setExpandedFolders(prev => new Set([...prev, folderPath]));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const renderFileTree = () => {
    const sortedPaths = Object.keys(files).sort();
    const tree: JSX.Element[] = [];

    for (const filePath of sortedPaths) {
      if (filePath === '/') continue;

      const pathParts = filePath.split('/').filter(Boolean);
      const depth = pathParts.length - 1;
      const name = pathParts[pathParts.length - 1];
      const parentPath = '/' + pathParts.slice(0, -1).join('/');

      if (depth > 0 && !expandedFolders.has(parentPath)) continue;

      const isFolder = files[filePath].type === 'folder';
      const isExpanded = expandedFolders.has(filePath);
      const isSelected = selectedFile === filePath;
      const isDragTarget = dragOverFolder === filePath;

      tree.push(
        <div
          key={filePath}
          className={cn(
            'flex items-center cursor-pointer px-2 py-1 text-sm rounded-md mx-1 transition-all duration-150',
            'hover:bg-elevated/60 bolt-hover',
            isSelected && !isFolder && 'bg-accent/20 hover:bg-accent/25 shadow-sm',
            isDragTarget && isFolder && 'ring-1 ring-accent bg-accent/15',
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (isFolder) toggleFolder(filePath);
            else onFileSelect(filePath);
          }}
          // Folder rows advertise themselves as drop targets
          onDragEnter={isFolder ? (e) => onFolderDragEnter(e, filePath) : undefined}
          onDragOver={isFolder ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
        >
          {isFolder ? (
            <>
              {isExpanded ? (
                <ChevronDown size={14} className="mr-1 text-muted" />
              ) : (
                <ChevronRight size={14} className="mr-1 text-muted" />
              )}
              {isExpanded ? (
                <FolderOpen size={16} className={cn('mr-2', isDragTarget ? 'text-accent' : 'text-accent')} />
              ) : (
                <Folder size={16} className="mr-2 text-accent" />
              )}
            </>
          ) : (
            <>
              <div className="w-4 mr-1" />
              <FileIcon filename={name} />
            </>
          )}
          <span className={cn(
            'truncate',
            isSelected && !isFolder ? 'text-fg' : 'text-muted',
            isDragTarget && isFolder && 'text-accent font-medium',
          )}>
            {name}
          </span>
        </div>
      );
    }

    return tree;
  };

  // Root row drag target
  const isRootTarget = dragOverFolder === '/';

  return (
    <div
      className={cn(
        'p-2 text-fg relative transition-all duration-150',
        isDraggingOver && 'ring-1 ring-inset ring-accent/40 rounded-lg bg-accent/5',
      )}
      onDragEnter={onContainerDragEnter}
      onDragLeave={onContainerDragLeave}
      onDragOver={onContainerDragOver}
      onDrop={onContainerDrop}
    >
      {/* Root "Project" row */}
      <div
        className={cn(
          'flex items-center cursor-pointer hover:bg-elevated/60 px-2 py-1 text-sm rounded-md bolt-hover transition-all duration-150',
          isRootTarget && isDraggingOver && 'ring-1 ring-accent bg-accent/15',
        )}
        onClick={() => toggleFolder('/')}
        onDragEnter={(e) => { e.stopPropagation(); setDragOverFolder('/'); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        {expandedFolders.has('/') ? (
          <ChevronDown size={14} className="mr-1 text-muted" />
        ) : (
          <ChevronRight size={14} className="mr-1 text-muted" />
        )}
        {expandedFolders.has('/') ? (
          <FolderOpen size={16} className="mr-2 text-accent" />
        ) : (
          <Folder size={16} className="mr-2 text-accent" />
        )}
        <span className={cn('text-muted flex-1', isRootTarget && isDraggingOver && 'text-accent font-medium')}>
          Project
        </span>
      </div>

      {expandedFolders.has('/') && renderFileTree()}

      {/* Drop overlay — only shown while dragging over the tree */}
      {isDraggingOver && (
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-end pb-4 gap-1">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent/90 text-accent-foreground text-xs font-medium shadow-lg">
            <UploadCloud size={13} />
            Drop into{' '}
            {dragOverFolder === '/' || !dragOverFolder
              ? 'Project root'
              : dragOverFolder.split('/').filter(Boolean).pop()}
          </div>
        </div>
      )}
    </div>
  );
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase();

  const getIconColor = (extension: string) => {
    switch (extension) {
      case 'js':
      case 'jsx':
        return 'text-yellow-400';
      case 'ts':
      case 'tsx':
        return 'text-blue-400';
      case 'json':
        return 'text-yellow-600';
      case 'md':
        return 'text-blue-300';
      case 'html':
        return 'text-orange-400';
      case 'css':
      case 'scss':
        return 'text-blue-500';
      case 'py':
        return 'text-green-400';
      case 'rb':
        return 'text-red-400';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
      case 'webp':
      case 'ico':
        return 'text-purple-400';
      default:
        return 'text-muted';
    }
  };

  return <File size={16} className={cn('mr-2', getIconColor(ext || ''))} />;
}
