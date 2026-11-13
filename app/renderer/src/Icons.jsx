// Icons: Lucide line icons, plus custom glyphs for filled stop square and file-type badges.
import {
  Activity, Archive, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Atom, BookOpen, Braces, Brain, BriefcaseBusiness,
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Code, Copy, CornerDownLeft, Database,
  Download, Ellipsis, ExternalLink, File, FileCode, FileDiff, FileImage, FilePen, FileText, FoldVertical,
  Folder, FolderOpen, GitBranch, GitFork, Globe, Gauge, KeyRound, Laptop, Layers, ListChecks, ListTree,
  Maximize2, MessageCircleQuestion, MessageSquare, Minimize2, Moon, PanelLeft, PanelRight, Paperclip,
  Pencil, Plus, RefreshCw, Search, Server, Settings, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles,
  SquareTerminal, StickyNote, Sun, Target, Terminal, Timer, Trash2, TriangleAlert, Unplug, Wifi, Wrench,
  X, Zap, Infinity as InfinityIcon,
} from 'lucide-react';

const LUCIDE = {
  sun: Sun, moon: Moon, book: BookOpen, customize: BriefcaseBusiness,
  plus: Plus, search: Search, settings: Settings, terminal: SquareTerminal, laptop: Laptop, folder: Folder, folderOpen: FolderOpen,
  chevronDown: ChevronDown, chevronRight: ChevronRight, chevronUp: ChevronUp, caretDown: ChevronDown, caretRight: ChevronRight,
  check: Check, arrowUp: ArrowUp, arrowUpRight: ArrowUpRight, panel: PanelRight,
  sidebar: PanelLeft, sidebarToggle: PanelLeft, sparkle: Sparkles, shield: ShieldCheck, shieldAlert: ShieldAlert,
  file: StickyNote, fileEdit: FilePen, x: X, alert: TriangleAlert, brain: Brain, refresh: RefreshCw, server: Server,
  key: KeyRound, trash: Trash2, edit: Pencil, globe: Globe, more: Ellipsis, archive: Archive, back: ChevronLeft,
  forward: ChevronRight, branch: GitBranch, enter: CornerDownLeft, compact: FoldVertical, copy: Copy, list: ListChecks,
  arrowLeft: ArrowLeft, unplug: Unplug, wifi: Wifi, question: MessageCircleQuestion, gauge: Gauge, database: Database,
  arrowDown: ArrowDown, timer: Timer, fileText: FileText, fileCode: FileCode, fileImage: FileImage, listTree: ListTree,
  externalLink: ExternalLink, code: Code, fileAny: File, maximize: Maximize2, minimize: Minimize2, paperclip: Paperclip,
  target: Target, fork: GitFork, fileDiff: FileDiff, terminalPanel: SquareTerminal, download: Download, chat: MessageSquare,
  console: Terminal, wrench: Wrench, bolt: Zap, infinity: InfinityIcon,
  atom: Atom, braces: Braces, clock: Clock, activity: Activity, layers: Layers, sliders: SlidersHorizontal,
};

const GLYPHS = {
  stop: 'M8.5 7.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
};

export function Icon({ name, size = 16, stroke = 1.75, className, style }) {
  if (GLYPHS[name]) {
    return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
  }
  const Component = LUCIDE[name] ?? Ellipsis;
  return <Component className={className} style={style} size={size} strokeWidth={stroke} absoluteStrokeWidth={false} aria-hidden="true" />;
}

// Soft warm π emblem in Claude Desktop style.
export function Mascot({ size = 7, className }) {
  const px = size * 7;
  return (
    <svg className={className} width={px} height={px} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="40" height="40" rx="13" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" />
      <path
        d="M14.8 18.2C16.4 16.9 18.3 16.5 21.2 16.5H33.5M20.8 16.5C20.5 22.8 19.4 28.2 17.3 32.4M28.2 16.5V28.3C28.2 30.7 29.3 32.1 31.3 32.1C32.4 32.1 33.3 31.6 33.9 30.8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Soft warm terracotta Claude Code emblem.
export function ClaudeMascot({ size = 7, className }) {
  const px = size * 7;
  return (
    <svg className={className} width={px} height={px} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="40" height="40" rx="13" fill="#da7756" fillOpacity="0.11" stroke="#da7756" strokeOpacity="0.26" strokeWidth="1" />
      <path d="M15.5 18.5L21.5 24L15.5 29.5M24.5 29.5H32.5" stroke="#da7756" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Pi mark: a small "π" glyph used as the app's logo.
export function PiMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#27272a" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
      <path d="M8.5 11h15M12.5 11v11M19.5 11v8.5c0 1.6.8 2.5 2.4 2.5" stroke="#f4f4f6" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}
