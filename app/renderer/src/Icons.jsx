// Icons: Lucide line icons (the same family Claude Desktop's icon set resembles), plus a few glyphs
// Lucide has no equivalent for (filled carets, stop square).
import {
  Archive, ArrowLeft, ArrowUp, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerDownLeft, Ellipsis, Sun, Moon, BookOpen, BriefcaseBusiness,
  FilePen, FoldVertical, Folder, GitBranch, Globe, KeyRound, Laptop, ListChecks, PanelLeft, PanelRight, Pencil, Plus,
  RefreshCw, Search, Server, Settings, ShieldAlert, ShieldCheck, Sparkles, SquareTerminal, StickyNote, Trash2,
  TriangleAlert, Unplug, Wifi, X, MessageCircleQuestion, Gauge, Database, ArrowDown, Timer, FileText, FileCode, FileImage, ListTree, ExternalLink, Code, File, Maximize2, Minimize2, Paperclip, Target, GitFork, FileDiff, Download, MessageSquare, Terminal, Wrench, Zap, Infinity as InfinityIcon,
} from 'lucide-react';

const LUCIDE = {
  sun: Sun, moon: Moon, book: BookOpen, customize: BriefcaseBusiness,
  plus: Plus, search: Search, settings: Settings, terminal: SquareTerminal, laptop: Laptop, folder: Folder,
  chevronDown: ChevronDown, chevronRight: ChevronRight, caretDown: ChevronDown, caretRight: ChevronRight,
  check: Check, arrowUp: ArrowUp, panel: PanelRight,
  sidebar: PanelLeft, sidebarToggle: PanelLeft, sparkle: Sparkles, shield: ShieldCheck, shieldAlert: ShieldAlert,
  file: StickyNote, fileEdit: FilePen, x: X, alert: TriangleAlert, brain: Brain, refresh: RefreshCw, server: Server,
  key: KeyRound, trash: Trash2, edit: Pencil, globe: Globe, more: Ellipsis, archive: Archive, back: ChevronLeft,
  forward: ChevronRight, branch: GitBranch, enter: CornerDownLeft, compact: FoldVertical, copy: Copy, list: ListChecks,
  arrowLeft: ArrowLeft, unplug: Unplug, wifi: Wifi, question: MessageCircleQuestion, gauge: Gauge, database: Database, arrowDown: ArrowDown, timer: Timer, fileText: FileText, fileCode: FileCode, fileImage: FileImage, listTree: ListTree, externalLink: ExternalLink, code: Code, fileAny: File, maximize: Maximize2, minimize: Minimize2, paperclip: Paperclip, target: Target, fork: GitFork, fileDiff: FileDiff, terminalPanel: SquareTerminal, download: Download, chat: MessageSquare, console: Terminal, wrench: Wrench, bolt: Zap, infinity: InfinityIcon,
};

const GLYPHS = {
  stop: 'M9 7.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 15V9A1.5 1.5 0 0 1 9 7.5z',
};

export function Icon({ name, size = 16, stroke = 1.75, className, style }) {
  if (GLYPHS[name]) {
    return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
  }
  const Component = LUCIDE[name] ?? Ellipsis;
  return <Component className={className} style={style} size={size} strokeWidth={stroke} absoluteStrokeWidth={false} aria-hidden="true" />;
}

// Elegant editorial π emblem with subtle warm glow — fits Claude's refined minimalism.
export function Mascot({ size = 7, className }) {
  const px = size * 8;
  return (
    <svg className={className} width={px} height={px} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="40" height="40" rx="13" fill="currentColor" fillOpacity="0.11" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1" />
      <path
        d="M14.5 18.2C16.2 16.9 18.1 16.5 21 16.5H33.5M20.8 16.5C20.5 22.8 19.4 28.2 17.2 32.5M28.2 16.5V28.4C28.2 30.8 29.3 32.2 31.4 32.2C32.5 32.2 33.4 31.7 34 30.9"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Pi mark: a small "π" glyph used as the app's logo.
export function PiMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#d97757" />
      <path d="M8.5 11h15M12.5 11v11M19.5 11v8.5c0 1.6.8 2.5 2.4 2.5" stroke="#1c1c1c" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
