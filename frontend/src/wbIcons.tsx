/**
 * Shared workbench icon set — thin wrappers over lucide-preact that bake in
 * strokeWidth=1.6 to match the hairline aesthetic throughout the IDE shell.
 *
 * Import from this file in all wb-* components instead of inlining SVG paths.
 */
import {
  BarChart3,
  Bookmark,
  ChevronRight,
  Database,
  Download,
  Files,
  GitBranch,
  HardDrive,
  History,
  Key,
  LogOut,
  Moon,
  PanelBottom,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  Sun,
  Table2,
  Terminal,
  X,
} from "lucide-preact";

const SW = 1.6;

export function SearchIcon({ size }: { size: number }) {
  return <Search size={size} strokeWidth={SW} />;
}
export function SunIcon({ size }: { size: number }) {
  return <Sun size={size} strokeWidth={SW} />;
}
export function MoonIcon({ size }: { size: number }) {
  return <Moon size={size} strokeWidth={SW} />;
}
export function LogOutIcon({ size }: { size: number }) {
  return <LogOut size={size} strokeWidth={SW} />;
}
export function FilesIcon({ size }: { size: number }) {
  return <Files size={size} strokeWidth={SW} />;
}
export function PlusIcon({ size }: { size: number }) {
  return <Plus size={size} strokeWidth={SW} />;
}
export function XIcon({ size }: { size: number }) {
  return <X size={size} strokeWidth={SW} />;
}
export function DatabaseIcon({ size }: { size: number }) {
  return <Database size={size} strokeWidth={SW} />;
}
export function SettingsIcon({ size }: { size: number }) {
  return <Settings size={size} strokeWidth={SW} />;
}
export function PanelIcon({ size }: { size: number }) {
  return <PanelBottom size={size} strokeWidth={SW} />;
}
export function TerminalIcon({ size }: { size: number }) {
  return <Terminal size={size} strokeWidth={SW} />;
}
/** Accepts an optional `class` prop so the chevron rotation animation works. */
export function ChevronIcon({ size, class: cls }: { size: number; class?: string }) {
  return <ChevronRight size={size} strokeWidth={SW} class={cls} />;
}
export function TableIcon({ size }: { size: number }) {
  return <Table2 size={size} strokeWidth={SW} />;
}
export function TransformIcon({ size }: { size: number }) {
  return <GitBranch size={size} strokeWidth={SW} />;
}
export function BookmarkIcon({ size }: { size: number }) {
  return <Bookmark size={size} strokeWidth={SW} />;
}
export function JobIcon({ size }: { size: number }) {
  return <Download size={size} strokeWidth={SW} />;
}
export function ChartIcon({ size }: { size: number }) {
  return <BarChart3 size={size} strokeWidth={SW} />;
}
export function KeyIcon({ size }: { size: number }) {
  return <Key size={size} strokeWidth={SW} />;
}
export function DriveIcon({ size }: { size: number }) {
  return <HardDrive size={size} strokeWidth={SW} />;
}
export function PlayIcon({ size }: { size: number }) {
  return <Play size={size} strokeWidth={SW} />;
}
export function SaveIcon({ size }: { size: number }) {
  return <Save size={size} strokeWidth={SW} />;
}
export function RefreshIcon({ size }: { size: number }) {
  return <RotateCcw size={size} strokeWidth={SW} />;
}
export function HistoryIcon({ size }: { size: number }) {
  return <History size={size} strokeWidth={SW} />;
}
