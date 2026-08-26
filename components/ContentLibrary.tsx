"use client";
import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { Grid as GridComponent } from "react-window";
import { AutoSizer } from "react-virtualized-auto-sizer";
import { useSession } from "next-auth/react";
import {
	Folder,
	Video,
	MoreVertical,
	Upload,
	Plus,
	ArrowLeft,
	Check,
	Trash2,
	Edit2,
	Search,
	ChevronRight,
	Move,
	Filter,
	X,
	Grid as GridIcon,
	List as ListIcon,
	ArrowDownAZ,
	ArrowUpAZ,
	ArrowDown01,
	ArrowUp01,
	TextCursorInput,
	ExternalLink,
	Eye,
	CornerDownRight,
	AlertCircle,
	Globe,
} from "lucide-react";
import IOSButton from "./IOSButton";
import {
	useDropzone,
	type DropEvent,
	type FileRejection,
} from "react-dropzone";
import { useRouter, useSearchParams } from "next/navigation";
import MoveContentModal from "./MoveContentModal";
import { useUploadActions } from "@/contexts/UploadContext";
import { collectDroppedFiles } from "@/lib/upload-drop";
import IOSToast, { ToastType } from "./IOSToast";
import { useRef } from "react";
import EditContentModal from "./EditContentModal";
import ImageEditorModal from "./ImageEditorModal";
import ImportUrlModal from "./ImportUrlModal";
import { Palette } from "lucide-react";

const formatBytes = (bytes: number) => {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const formatTime = (seconds: number) => {
	if (!isFinite(seconds) || seconds < 0) return "--";
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}m ${s}s`;
};

const SORT_OPTIONS = [
	"name-asc",
	"name-desc",
	"created-asc",
	"created-desc",
] as const;
type SortOption = (typeof SORT_OPTIONS)[number];

interface ContentItem {
	id: string;
	type: "image" | "video" | "carousel_folder" | "carousel_item";
	name: string;
	title?: string;
	caption?: string;
	url?: string;
	path?: string;
	tags?: string[];
	description?: string;
	parent_id?: string | null;
	created_at: string;
	size?: number; // bytes
	duration?: number; // seconds
	thumbnail_url?: string; // Add thumbnail URL for carousel preview
}

/** Tags are stored as JSON string in DB. Normalize to array safely. */
function normalizeTags(raw: unknown): string[] {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw as string[];
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}
	return [];
}

function normalizeItem(item: ContentItem): ContentItem {
	return { ...item, tags: normalizeTags(item.tags) };
}

function expandTypeFilters(types: string[]): string[] {
	const expanded = new Set<string>();
	for (const type of types) {
		if (type === "image") {
			expanded.add("image");
			expanded.add("carousel_item");
		} else {
			expanded.add(type);
		}
	}
	return Array.from(expanded);
}

function sizeRangeForFilter(filter: "all" | "small" | "medium" | "large"): {
	min?: number;
	max?: number;
} {
	if (filter === "small") return { max: 5 * 1024 * 1024 };
	if (filter === "medium")
		return { min: 5 * 1024 * 1024, max: 20 * 1024 * 1024 };
	if (filter === "large") return { min: 20 * 1024 * 1024 };
	return {};
}

function durationRangeForFilter(filter: "all" | "short" | "medium" | "long"): {
	min?: number;
	max?: number;
} {
	if (filter === "short") return { max: 15 };
	if (filter === "medium") return { min: 15, max: 60 };
	if (filter === "long") return { min: 60 };
	return {};
}

interface ContentLibraryProps {
	mode?: "manage" | "select";
	onSelectionChange?: (selectedIds: string[]) => void;
	initialSelection?: string[];
	allowedTypes?: string[]; // 'video', 'image', 'carousel'
	disableUrlNavigation?: boolean;
}

interface GridCellData {
	columnCount: number;
	sortedItems: ContentItem[];
	handleDragStart: (e: React.DragEvent, itemId: string) => void;
	handleDragEnd: () => void;
	handleDragOver: (
		e: React.DragEvent,
		targetId: string | null,
		targetItem: ContentItem | null,
	) => void;
	handleDragLeave: (e: React.DragEvent) => void;
	handleDrop: (e: React.DragEvent, targetId: string | null) => void;
	mode: "manage" | "select";
	disableUrlNavigation: boolean;
	toggleSelection: (id: string) => void;
	setInternalFolderId: (id: string | null) => void;
	router: ReturnType<typeof useRouter>;
	selectedIds: string[];
	dropTargetId: string | null;
	draggedItems: string[];
	openEditModal: (items: ContentItem[]) => void;
	openImageEditor: (item: ContentItem) => void;
	deleteItem: (e: React.MouseEvent, item: ContentItem) => void;
	openMoveModal: (items: ContentItem[]) => void;
	formatBytes: (bytes: number) => string;
	formatTime: (seconds: number) => string;
}

interface GridCellProps {
	columnIndex: number;
	rowIndex: number;
	style: React.CSSProperties;
	data: GridCellData;
}

const GridCellInner = ({
	columnIndex,
	rowIndex,
	style,
	data,
}: GridCellProps) => {
	const {
		columnCount,
		sortedItems,
		handleDragStart,
		handleDragEnd,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		mode,
		disableUrlNavigation,
		toggleSelection,
		setInternalFolderId,
		router,
		selectedIds,
		dropTargetId,
		draggedItems,
		openEditModal,
		openImageEditor,
		deleteItem,
		openMoveModal,
		formatBytes,
		formatTime,
	} = data;

	const index = rowIndex * columnCount + columnIndex;
	if (index >= sortedItems.length) return null; // Empty slots at end of last row
	const item = sortedItems[index];

	return (
		<div style={{ ...style, padding: "0.5rem" }}>
			<div
				key={item.id}
				draggable={item.type !== "carousel_folder"}
				onDragStart={(e) =>
					item.type !== "carousel_folder" && handleDragStart(e, item.id)
				}
				onDragEnd={handleDragEnd}
				onDragOver={(e) => handleDragOver(e, item.id, item)}
				onDragLeave={handleDragLeave}
				onDrop={(e) => item.type === "carousel_folder" && handleDrop(e, item.id)}
				onClick={() => {
					if (item.type === "carousel_folder") {
						if (mode === "select" && disableUrlNavigation) {
							toggleSelection(item.id);
						} else {
							disableUrlNavigation
								? setInternalFolderId(item.id)
								: router.push(`/content?folderId=${item.id}`);
						}
					} else {
						toggleSelection(item.id);
					}
				}}
				className={`
                    w-full h-full group relative aspect-square rounded-2xl border overflow-hidden cursor-pointer transition-all duration-200
                    ${
																					selectedIds.includes(item.id)
																						? "ring-2 ring-ios-blue border-transparent shadow-lg scale-[1.02]"
																						: "border-ios-separator hover:border-ios-blue/50 hover:shadow-md"
																				}
                    ${dropTargetId === item.id ? "ring-2 ring-green-500 scale-105 bg-green-50 dark:bg-green-900/20" : ""}
                    ${draggedItems.includes(item.id) ? "opacity-50" : ""}
                    bg-ios-card
                `}
			>
				{/* Thumbnail Content */}
				{item.type === "carousel_folder" ? (
					<div className="w-full h-full flex flex-col items-center justify-center bg-blue-50/50 dark:bg-blue-900/5 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors relative overflow-hidden">
						{item.thumbnail_url ? (
							<>
								<img
									src={item.thumbnail_url}
									loading="lazy"
									decoding="async"
									className="absolute inset-0 w-full h-full object-cover opacity-60 blur-[1px] group-hover:blur-0 transition-all duration-300"
								/>
								<div className="absolute inset-0 bg-white/30 dark:bg-black/30 group-hover:bg-transparent transition-colors" />
								<div className="relative z-10 flex flex-col items-center">
									<Folder
										size={48}
										strokeWidth={1.5}
										className="text-white drop-shadow-lg fill-white/20"
									/>
								</div>
							</>
						) : (
							<Folder
								size={48}
								strokeWidth={1}
								className="text-blue-400 fill-blue-400/20"
							/>
						)}

						<span
							className={`text-xs font-medium mt-3 px-3 text-center truncate w-full relative z-10 flex-shrink-0 ${item.thumbnail_url ? "text-white drop-shadow-md" : "text-ios-secondary"}`}
						>
							{item.name}
						</span>
					</div>
				) : (
					<div className="w-full h-full relative">
						{item.type === "video" ? (
							item.thumbnail_url ? (
								<img
									src={item.thumbnail_url}
									alt={item.name}
									loading="lazy"
									decoding="async"
									className="w-full h-full object-cover"
								/>
							) : (
								<div className="w-full h-full bg-gray-900 flex items-center justify-center relative">
									{/* No <video> tag — avoids loading/decoding video frames (saves RAM & CPU) */}
									<div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 flex items-center justify-center">
										<Video className="text-white/70 fill-white/20" size={22} />
									</div>
								</div>
							)
						) : (
							<img
								src={item.url}
								alt={item.name}
								loading="lazy"
								decoding="async"
								className="w-full h-full object-cover"
							/>
						)}

						{/* Overlay Info (Gradient) */}
						<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-8 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end">
							<p className="text-white text-xs font-medium truncate drop-shadow-sm">
								{item.name}
							</p>
							{/* Size / Duration Badge */}
							<div className="flex items-center gap-2 mt-1 text-[10px] text-gray-200">
								{item.size && <span>{formatBytes(item.size)}</span>}
								{item.duration ? <span>• {formatTime(item.duration)}</span> : null}
							</div>
						</div>
					</div>
				)}

				{/* Selection Checkbox */}
				{selectedIds.includes(item.id) && (
					<div className="absolute top-2 right-2 bg-ios-blue text-white rounded-full p-1 shadow-sm z-20 animate-in zoom-in duration-200">
						<Check size={12} strokeWidth={3} />
					</div>
				)}

				{/* Bottom Left: Enter Folder Button */}
				{item.type === "carousel_folder" && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							disableUrlNavigation
								? setInternalFolderId(item.id)
								: router.push(`/content?folderId=${item.id}`);
						}}
						className="absolute bottom-2 left-2 p-1.5 bg-black/50 hover:bg-black/70 backdrop-blur text-white rounded-full shadow-sm transition-all z-20 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
						title="Open Folder"
					>
						<CornerDownRight size={14} />
					</button>
				)}

				{/* Bottom Right: Preview Button */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						window.open(item.url, "_blank");
					}}
					className="absolute bottom-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 backdrop-blur text-white rounded-full shadow-sm transition-all z-20 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
					title="Preview"
				>
					<Eye size={14} />
				</button>

				{/* Hover Actions (Context Menu triggers) */}
				<div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 translate-x-2 group-hover:translate-x-0 duration-200">
					<button
						onClick={(e) => {
							e.stopPropagation();
							openEditModal([item]);
						}}
						className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-blue-500 transition-colors"
						title="Edit Metadata"
					>
						<Edit2 size={12} />
					</button>
					{(item.type === "image" || item.type === "carousel_item") && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								openImageEditor(item);
							}}
							className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-purple-500 transition-colors"
							title="Edit Image"
						>
							<Palette size={12} />
						</button>
					)}
					{mode === "manage" && (
						<>
							<button
								onClick={(e) => {
									e.stopPropagation();
									openMoveModal([item]);
								}}
								className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-blue-500 transition-colors"
								title="Move"
							>
								<Move size={12} />
							</button>
							<button
								onClick={(e) => deleteItem(e, item)}
								className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-red-500 transition-colors"
								title="Delete"
							>
								<Trash2 size={12} />
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
};

/**
 * Shallow-compare GridCell props so a parent re-render (toast, bulk loading,
 * unrelated state) does not re-render every visible cell. `data` (itemData) is
 * memoized upstream with useMemo; style/position are compared by value because
 * react-window recreates the style object on resize/scroll.
 */
const gridCellComparer = (prev: GridCellProps, next: GridCellProps) =>
	prev.rowIndex === next.rowIndex &&
	prev.columnIndex === next.columnIndex &&
	prev.data === next.data &&
	prev.style?.width === next.style?.width &&
	prev.style?.height === next.style?.height &&
	prev.style?.left === next.style?.left &&
	prev.style?.top === next.style?.top;

// SAFETY: react-window v2 invokes cellComponent with the static shape
// { data, columnIndex, rowIndex, style } (cellProps supplies `data`);
// GridCellInner reads every other value from that single `data` object, so
// the narrower prop type is guaranteed at every call site even though
// memo() widens it.
const GridCell = memo(GridCellInner, gridCellComparer) as unknown as (props: {
	data: GridCellData;
}) => React.ReactElement | null;

interface GridAreaProps {
	height: number;
	width: number;
	sortedItems: ContentItem[];
	selectedIds: string[];
	dropTargetId: string | null;
	draggedItems: string[];
	mode: "manage" | "select";
	disableUrlNavigation: boolean;
	hasMore: boolean;
	loadingMore: boolean;
	itemsCount: number;
	totalCount: number;
	loadMore: () => void;
	handleScroll: (e: React.UIEvent<HTMLDivElement>) => void;
	toggleSelection: (id: string) => void;
	handleDragStart: (e: React.DragEvent, itemId: string) => void;
	handleDragEnd: () => void;
	handleDragOver: (
		e: React.DragEvent,
		targetId: string | null,
		targetItem: ContentItem | null,
	) => void;
	handleDragLeave: (e: React.DragEvent) => void;
	handleDrop: (e: React.DragEvent, targetId: string | null) => void;
	setInternalFolderId: (id: string | null) => void;
	router: ReturnType<typeof useRouter>;
	openEditModal: (items: ContentItem[]) => void;
	openImageEditor: (item: ContentItem) => void;
	deleteItem: (e: React.MouseEvent, item: ContentItem) => void;
	openMoveModal: (items: ContentItem[]) => void;
}

/**
 * The virtualized grid area. Extracted into a memoized component so the
 * AutoSizer render-prop stays a thin wrapper: itemData is built with useMemo
 * here (inside a real component, where hooks are allowed) and the grid only
 * re-renders when its actual inputs change.
 */
const GridArea = memo(function GridArea(props: GridAreaProps) {
	const {
		height,
		width,
		sortedItems,
		selectedIds,
		dropTargetId,
		draggedItems,
		mode,
		disableUrlNavigation,
		hasMore,
		loadingMore,
		itemsCount,
		totalCount,
		loadMore,
		handleScroll,
		toggleSelection,
		handleDragStart,
		handleDragEnd,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		setInternalFolderId,
		router,
		openEditModal,
		openImageEditor,
		deleteItem,
		openMoveModal,
	} = props;

	// Calculate how many columns fit (min item width ~160px)
	const MIN_ITEM_WIDTH = 160;
	const columnCount = Math.max(2, Math.floor(width / MIN_ITEM_WIDTH));
	const rowCount = Math.ceil(sortedItems.length / columnCount);
	const columnWidth = width / columnCount;
	const rowHeight = columnWidth; // aspect-square
	const footerHeight = hasMore || loadingMore ? 56 : 0;

	const itemData = useMemo(
		() => ({
			columnCount,
			sortedItems,
			handleDragStart,
			handleDragEnd,
			handleDragOver,
			handleDragLeave,
			handleDrop,
			mode,
			disableUrlNavigation,
			toggleSelection,
			setInternalFolderId,
			router,
			selectedIds,
			dropTargetId,
			draggedItems,
			openEditModal,
			openImageEditor,
			deleteItem,
			openMoveModal,
			formatBytes,
			formatTime,
		}),
		[
			columnCount,
			sortedItems,
			selectedIds,
			dropTargetId,
			draggedItems,
			mode,
			disableUrlNavigation,
			handleDragStart,
			handleDragEnd,
			handleDragOver,
			handleDragLeave,
			handleDrop,
			toggleSelection,
			setInternalFolderId,
			router,
			openEditModal,
			openImageEditor,
			deleteItem,
			openMoveModal,
		],
	);

	return (
		<>
			<GridComponent
				className="scroller outline-none"
				columnCount={columnCount}
				columnWidth={columnWidth}
				rowCount={rowCount}
				rowHeight={rowHeight}
				style={{ height: Math.max(0, height - footerHeight), width }}
				onScroll={handleScroll}
				cellComponent={GridCell}
				cellProps={{ data: itemData }}
			/>
			<div
				style={{ height: footerHeight }}
				className="flex items-center justify-center"
			>
				{loadingMore ? (
					<div className="animate-spin rounded-full h-6 w-6 border-b-2 border-ios-blue" />
				) : hasMore ? (
					<button
						onClick={loadMore}
						className="text-sm text-ios-blue hover:underline"
					>
						Load more ({itemsCount} of {totalCount})
					</button>
				) : null}
			</div>
		</>
	);
});

export default function ContentLibrary({
	mode = "manage",
	onSelectionChange,
	initialSelection = [],
	allowedTypes = ["video", "image", "carousel_folder", "carousel_item"],
	disableUrlNavigation = false,
}: ContentLibraryProps) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { data: session } = useSession();

	// URL state for navigation
	const urlFolderId = searchParams.get("folderId") || null;
	const [internalFolderId, setInternalFolderId] = useState<string | null>(null);

	// Effective Folder ID based on navigation mode
	const currentFolderId = disableUrlNavigation ? internalFolderId : urlFolderId;

	const [items, setItems] = useState<ContentItem[]>([]);
	// Track the folder object for the current ID (for name display)
	const [currentFolder, setCurrentFolder] = useState<ContentItem | null>(null);
	const [folderPath, setFolderPath] = useState<ContentItem[]>([]);

	const [loading, setLoading] = useState(true);
	const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection);
	// Value-sync with the parent's initialSelection: adopt external changes
	// that arrive after mount (e.g. the wizard finishes loading a planner
	// after this library mounted, or the library remounts on tab switch).
	// Adoption stops once the user interacts locally — from then on the
	// parent only echoes our own onSelectionChange output, so re-adopting
	// could clobber newer local choices during an echo round-trip.
	const initialSelectionKey = useMemo(
		() => [...new Set(initialSelection)].sort().join("\n"),
		[initialSelection],
	);
	const lastInitialSelectionKeyRef = useRef<string | null>(initialSelectionKey);
	const selectionTouchedRef = useRef(false);
	useEffect(() => {
		if (lastInitialSelectionKeyRef.current === initialSelectionKey) return;
		lastInitialSelectionKeyRef.current = initialSelectionKey;
		if (selectionTouchedRef.current) return;
		const next = initialSelectionKey ? initialSelectionKey.split("\n") : [];
		setSelectedIds(next);
		setSelectionOrder([...next]);
	}, [initialSelectionKey]);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [showFilters, setShowFilters] = useState(false);
	const [filterTags, setFilterTags] = useState<string[]>([]);
	const [excludeTags, setExcludeTags] = useState<string[]>([]);
	const [filterTypes, setFilterTypes] = useState<string[]>([]);
	const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
		if (typeof window === "undefined") return "grid";
		return window.localStorage.getItem("cl.viewMode") === "list"
			? "list"
			: "grid";
	});
	const [sizeFilter, setSizeFilter] = useState<
		"all" | "small" | "medium" | "large"
	>("all");
	const [durationFilter, setDurationFilter] = useState<
		"all" | "short" | "medium" | "long"
	>("all");

	// Pagination state
	const [totalCount, setTotalCount] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [currentOffset, setCurrentOffset] = useState(0);
	const [loadingMore, setLoadingMore] = useState(false);
	const [selectAllServer, setSelectAllServer] = useState(false);
	const [bulkLoading, setBulkLoading] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const PAGE_SIZE = 100;
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	// Abort in-flight content fetches when a newer one starts (prevents stale overwrites)
	const contentFetchAbortRef = useRef<AbortController | null>(null);

	// Drag-drop items into folders
	const [draggedItems, setDraggedItems] = useState<string[]>([]);
	const [dropTargetId, setDropTargetId] = useState<string | null>(null);

	// Sorting inside folders
	const [sortBy, setSortBy] = useState<SortOption>(() => {
		if (typeof window === "undefined") return "name-asc";
		const saved = window.localStorage.getItem("cl.sortBy");
		return (SORT_OPTIONS as readonly string[]).includes(saved ?? "")
			? (saved as SortOption)
			: "name-asc";
	});

	// Create-folder dialog (replaces window.prompt)
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");

	// Bulk move (Select-All) dialog — pick a destination folder server-side
	const [isBulkMoveOpen, setIsBulkMoveOpen] = useState(false);
	const [bulkMoveTarget, setBulkMoveTarget] = useState<string | null>(null);
	const [moveFolders, setMoveFolders] = useState<ContentItem[]>([]);

	// Bulk rename modal
	const [isBulkRenameOpen, setIsBulkRenameOpen] = useState(false);
	const [bulkRenamePrefix, setBulkRenamePrefix] = useState("");
	const [selectionOrder, setSelectionOrder] = useState<string[]>([]);

	// Modal states
	const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
	const [moveItems, setMoveItems] = useState<ContentItem[]>([]);

	// Edit Modal State
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [itemsToEdit, setItemsToEdit] = useState<ContentItem[]>([]);
	const [editingItem, setEditingItem] = useState<ContentItem | null>(null); // Legacy, kept for logic but unused if we switch full to modal

	// Image Editor State
	const [imageEditorItem, setImageEditorItem] = useState<ContentItem | null>(
		null,
	);
	const [isImageEditorOpen, setIsImageEditorOpen] = useState(false);

	// Import URL Modal State
	const [isImportModalOpen, setIsImportModalOpen] = useState(false);

	// Global Upload Queue — actions-only hook (stable reference; the tasks
	// slice lives in useUploadTasks so unrelated re-renders don't flood the grid)
	const { addFiles, addFolderFiles } = useUploadActions();

	// Toast State
	const [toast, setToast] = useState<{
		msg: string;
		type: ToastType;
		show: boolean;
	}>({ msg: "", type: "success", show: false });

	// File Input Ref for Upload Button
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const id = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
		return () => window.clearTimeout(id);
	}, [search]);

	// Persist view/sort preferences across sessions
	useEffect(() => {
		try {
			window.localStorage.setItem("cl.viewMode", viewMode);
		} catch {
			/* ignore quota/security errors */
		}
	}, [viewMode]);
	useEffect(() => {
		try {
			window.localStorage.setItem("cl.sortBy", sortBy);
		} catch {
			/* ignore */
		}
	}, [sortBy]);

	// -------------------------------------------------------------------------
	// Data Fetching & Navigation
	// -------------------------------------------------------------------------

	const buildQueryParams = useCallback(
		(folderId: string | null, offset: number) => {
			const params = new URLSearchParams();
			params.set("parent_id", folderId || "");
			params.set("limit", String(PAGE_SIZE));
			params.set("offset", String(offset));

			if (debouncedSearch) params.set("search", debouncedSearch);

			const typeSet = new Set<string>();
			const selectedTypes = filterTypes.length > 0 ? filterTypes : allowedTypes;
			expandTypeFilters(selectedTypes).forEach((type) => typeSet.add(type));
			const allowedSet = new Set(expandTypeFilters(allowedTypes));
			const finalTypes = Array.from(typeSet).filter((type) =>
				allowedSet.has(type),
			);
			const defaultAllowedTypes = [
				"video",
				"image",
				"carousel_folder",
				"carousel_item",
			];
			const shouldSendTypes =
				filterTypes.length > 0 ||
				allowedTypes.join(",") !== defaultAllowedTypes.join(",");
			if (shouldSendTypes && finalTypes.length > 0) {
				params.set("types", finalTypes.join(","));
			}

			if (filterTags.length > 0) params.set("include_tags", filterTags.join(","));
			if (excludeTags.length > 0)
				params.set("exclude_tags", excludeTags.join(","));

			const sizeRange = sizeRangeForFilter(sizeFilter);
			if (sizeRange.min !== undefined)
				params.set("size_min", String(sizeRange.min));
			if (sizeRange.max !== undefined)
				params.set("size_max", String(sizeRange.max));

			const durationRange = durationRangeForFilter(durationFilter);
			if (durationRange.min !== undefined)
				params.set("duration_min", String(durationRange.min));
			if (durationRange.max !== undefined)
				params.set("duration_max", String(durationRange.max));

			params.set("sort_by", sortBy);
			return params;
		},
		[
			PAGE_SIZE,
			allowedTypes,
			debouncedSearch,
			durationFilter,
			excludeTags,
			filterTags,
			filterTypes,
			sizeFilter,
			sortBy,
		],
	);

	// Fetch current folder details and its ancestors for Breadcrumbs
	useEffect(() => {
		const fetchFolderDetails = async () => {
			if (!currentFolderId) {
				setCurrentFolder(null);
				setFolderPath([]);
				return;
			}

			try {
				const res = await fetch(`/api/content-items/${currentFolderId}`);
				if (!res.ok) throw new Error("Folder not found");
				const folder = await res.json();
				setCurrentFolder(folder);

				const path: ContentItem[] = [folder];
				let pid = folder.parent_id;
				while (pid) {
					const parentRes = await fetch(`/api/content-items/${pid}`);
					if (!parentRes.ok) break;
					const parent = await parentRes.json();
					if (parent) {
						path.unshift(parent as ContentItem);
						pid = parent.parent_id;
					} else {
						pid = null; // stop if not found
					}
					if (path.length > 10) break;
				}
				setFolderPath(path);
			} catch (err) {
				console.error("Error fetching folder info:", err);
				// Redirect to root if not found?
				router.push("/content");
			}
		};

		fetchFolderDetails();
	}, [currentFolderId, router, disableUrlNavigation]); // Added disableUrlNavigation dependency to re-run if prop changes (unlikely) but correct. Removed currentFolderId from deps of fetchContent call if it was separate, but it's inside effect.

	const fetchContent = useCallback(
		async (folderId: string | null, opts?: { keepSelection?: boolean }) => {
			// Abort any in-flight request from a previous navigation/filter change
			contentFetchAbortRef.current?.abort();
			const controller = new AbortController();
			contentFetchAbortRef.current = controller;
			const keepSelection = opts?.keepSelection ?? false;

			setLoading(true);
			setFetchError(null);
			setCurrentOffset(0);
			setSelectAllServer(false);
			if (!keepSelection) {
				setSelectedIds([]);
				setSelectionOrder([]);
			}
			try {
				const res = await fetch(
					`/api/content-items?${buildQueryParams(folderId, 0).toString()}`,
					{ signal: controller.signal },
				);
				if (!res.ok) throw new Error("Failed to fetch items");
				const json = await res.json();
				const data = json.items || json;

				// Ignore responses from requests that were superseded
				if (controller.signal.aborted) return;

				setItems((data as ContentItem[]).map(normalizeItem));
				// When keepSelection is true we intentionally do NOT prune the
				// selection down to the freshly fetched page. Selection is
				// pagination-independent: ids beyond the first PAGE_SIZE items stay
				// selected so editing a planner shows EVERY previously chosen item
				// (user-reported bug: pruning to visibleIds here silently dropped
				// all selections past page 1, and "Load more" never brought them
				// back). Pruning happens only where an item is confirmed gone:
				// explicit deletes, or folder navigation (keepSelection=false).
				setTotalCount(json.totalCount ?? data.length);
				setHasMore(json.hasMore ?? false);
				setCurrentOffset(PAGE_SIZE);
			} catch (error: unknown) {
				if ((error as { name?: string })?.name === "AbortError") return;
				console.error("Error fetching content:", error);
				setItems([]);
				setFetchError(
					"Não foi possível carregar a biblioteca. Verifique sua conexão.",
				);
			} finally {
				setLoading(false);
				if (contentFetchAbortRef.current === controller) {
					contentFetchAbortRef.current = null;
				}
			}
		},
		[buildQueryParams],
	);

	const loadMore = useCallback(async () => {
		if (loadingMore || !hasMore) return;
		setLoadingMore(true);
		// Capture the folder at request time so a navigation mid-flight is ignored
		const folderAtStart = currentFolderId;
		try {
			const res = await fetch(
				`/api/content-items?${buildQueryParams(currentFolderId, currentOffset).toString()}`,
			);
			if (!res.ok) throw new Error("Failed to fetch more items");
			const json = await res.json();
			const data = json.items || json;

			// Stale response after navigating away — discard it
			if (folderAtStart !== currentFolderId) return;

			setItems((prev) => [...prev, ...(data as ContentItem[]).map(normalizeItem)]);
			setTotalCount(json.totalCount ?? items.length + data.length);
			setHasMore(json.hasMore ?? false);
			setCurrentOffset((prev) => prev + PAGE_SIZE);
		} catch (error) {
			console.error("Error loading more content:", error);
		} finally {
			setLoadingMore(false);
		}
	}, [
		loadingMore,
		hasMore,
		currentFolderId,
		currentOffset,
		items.length,
		buildQueryParams,
	]);

	// Track the last fetched folder: a refresh of the SAME folder (mount,
	// search/filter change) must PRESERVE the current selection — including the
	// wizard's initialSelection (user-reported: editing a planner lost the
	// selected posts because the first fetch cleared them). Only an explicit
	// folder navigation clears the selection.
	const lastFolderRef = useRef<string | null>(currentFolderId);
	useEffect(() => {
		const folderChanged = lastFolderRef.current !== currentFolderId;
		lastFolderRef.current = currentFolderId;
		fetchContent(currentFolderId, { keepSelection: !folderChanged });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		currentFolderId,
		debouncedSearch,
		filterTags,
		excludeTags,
		filterTypes,
		sizeFilter,
		durationFilter,
		sortBy,
	]);

	// Update parent selection callback
	useEffect(() => {
		if (mode === "select" && onSelectionChange) {
			onSelectionChange(selectedIds);
		}
	}, [selectedIds, mode, onSelectionChange]);

	// -------------------------------------------------------------------------
	// Actions (Upload, Drop, Create Folder)
	// -------------------------------------------------------------------------

	const onDrop = useCallback(
		async (
			acceptedFiles: File[],
			_rejections: FileRejection[] = [],
			event?: DropEvent,
		) => {
			try {
				if (!session?.user || acceptedFiles.length === 0) return;

				// Rebuild folder structure (webkitRelativePath) via the Entry API —
				// Chrome leaves it empty on folder drops, which would flatten
				// carousel folders into loose files.
				let files = acceptedFiles;
				try {
					if (event && "dataTransfer" in event && event.dataTransfer) {
						const collected = await collectDroppedFiles(event.dataTransfer);
						if (collected.length > 0) files = collected;
					}
				} catch {
					// keep acceptedFiles
				}

				// Detect if any files have webkitRelativePath (folder upload)
				const hasFolderStructure = files.some(
					(f) => f.webkitRelativePath && f.webkitRelativePath.includes("/"),
				);

				if (hasFolderStructure) {
					await addFolderFiles(files, currentFolderId || null);
				} else {
					addFiles(files, currentFolderId || null);
				}

				setToast({
					msg: "Uploads queued. Check the Uploads tab for details.",
					show: true,
					type: "info",
				});
			} catch (error) {
				console.error(error);
			}
		},
		[currentFolderId, addFiles, addFolderFiles, session],
	);

	const { getRootProps, getInputProps, isDragActive } = useDropzone({
		onDrop,
		noClick: true,
		noKeyboard: true,
	});

	const createFolder = useCallback(async () => {
		const name = newFolderName.trim();
		if (!name) return;

		try {
			const res = await fetch("/api/content-items", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					type: "carousel_folder",
					parent_id: currentFolderId,
				}),
			});
			if (!res.ok) throw new Error("Failed to create folder");
			setIsCreateFolderOpen(false);
			setNewFolderName("");
			fetchContent(currentFolderId, { keepSelection: true });
		} catch (error) {
			console.error(error);
		}
	}, [newFolderName, currentFolderId, fetchContent]);

	// -------------------------------------------------------------------------
	// Selection & CRUD Logic
	// -------------------------------------------------------------------------

	const toggleSelection = useCallback(
		(id: string) => {
			selectionTouchedRef.current = true;
			if (selectedIds.includes(id)) {
				setSelectedIds(selectedIds.filter((sid) => sid !== id));
				setSelectionOrder(selectionOrder.filter((sid) => sid !== id));
			} else {
				setSelectedIds([...selectedIds, id]);
				setSelectionOrder([...selectionOrder, id]);
			}
		},
		[selectedIds, selectionOrder],
	);

	// Drag-drop handlers for moving items into folders
	const handleDragStart = useCallback(
		(e: React.DragEvent, itemId: string) => {
			e.stopPropagation();
			// If item is selected, drag all selected; otherwise just this one
			const itemsToDrag = selectedIds.includes(itemId) ? selectedIds : [itemId];
			setDraggedItems(itemsToDrag);
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", itemsToDrag.join(","));
		},
		[selectedIds],
	);

	const handleDragOver = useCallback(
		(
			e: React.DragEvent,
			targetId: string | null,
			targetItem: ContentItem | null,
		) => {
			e.preventDefault();
			e.stopPropagation();
			// Only allow dropping on folders
			if (
				targetItem &&
				targetItem.type === "carousel_folder" &&
				!draggedItems.includes(targetItem.id)
			) {
				setDropTargetId(targetId);
				e.dataTransfer.dropEffect = "move";
			} else if (targetId === null && currentFolderId) {
				// Allow dropping to move to root (when dragging over empty area)
				setDropTargetId("root");
				e.dataTransfer.dropEffect = "move";
			}
		},
		[draggedItems, currentFolderId],
	);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setDropTargetId(null);
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent, targetId: string | null) => {
			e.preventDefault();
			e.stopPropagation();
			setDropTargetId(null);

			if (draggedItems.length === 0) return;

			const newParentId = targetId === "root" ? null : targetId;

			try {
				// Move all dragged items to the target folder
				for (const itemId of draggedItems) {
					await fetch(`/api/content-items/${itemId}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ parent_id: newParentId }),
					});
				}
				setToast({
					msg: `Moved ${draggedItems.length} item(s)`,
					type: "success",
					show: true,
				});
				fetchContent(currentFolderId, { keepSelection: true });
			} catch (error) {
				console.error("Move failed:", error);
				setToast({ msg: "Failed to move items", type: "error", show: true });
			}
			setDraggedItems([]);
		},
		[draggedItems, currentFolderId, fetchContent],
	);

	const handleDragEnd = useCallback(() => {
		setDraggedItems([]);
		setDropTargetId(null);
	}, []);

	// Build filter params for server-side bulk ops
	const buildFilterParams = useCallback(() => {
		const params: Record<string, string> = {};
		if (currentFolderId) params.parent_id = currentFolderId;
		else params.parent_id = "";
		const typeSet = new Set<string>();
		const selectedTypes = filterTypes.length > 0 ? filterTypes : allowedTypes;
		expandTypeFilters(selectedTypes).forEach((type) => typeSet.add(type));
		const allowedSet = new Set(expandTypeFilters(allowedTypes));
		const finalTypes = Array.from(typeSet).filter((type) => allowedSet.has(type));
		const defaultAllowedTypes = [
			"video",
			"image",
			"carousel_folder",
			"carousel_item",
		];
		const shouldSendTypes =
			filterTypes.length > 0 ||
			allowedTypes.join(",") !== defaultAllowedTypes.join(",");
		if (shouldSendTypes && finalTypes.length > 0)
			params.types = finalTypes.join(",");
		if (debouncedSearch) params.search = debouncedSearch;
		if (filterTags.length > 0) params.include_tags = filterTags.join(",");
		if (excludeTags.length > 0) params.exclude_tags = excludeTags.join(",");
		const sizeRange = sizeRangeForFilter(sizeFilter);
		if (sizeRange.min !== undefined) params.size_min = String(sizeRange.min);
		if (sizeRange.max !== undefined) params.size_max = String(sizeRange.max);
		const durationRange = durationRangeForFilter(durationFilter);
		if (durationRange.min !== undefined)
			params.duration_min = String(durationRange.min);
		if (durationRange.max !== undefined)
			params.duration_max = String(durationRange.max);
		params.sort_by = sortBy;
		return params;
	}, [
		allowedTypes,
		currentFolderId,
		debouncedSearch,
		durationFilter,
		excludeTags,
		filterTags,
		filterTypes,
		sizeFilter,
		sortBy,
	]);

	// Bulk rename — server-side bulk endpoint. When select-all is active, the
	// server enumerates ALL matching items (all:true + filters).
	const handleBulkRename = useCallback(async () => {
		if (!bulkRenamePrefix.trim()) return;
		if (selectionOrder.length === 0 && !selectAllServer) return;

		try {
			setBulkLoading(true);
			const body: Record<string, unknown> = { action: "rename" };
			if (selectAllServer) {
				body.all = true;
				body.filters = buildFilterParams();
				body.data = { new_name: bulkRenamePrefix.trim() };
			} else {
				body.ids = selectionOrder;
				body.data = { prefix: bulkRenamePrefix.trim() };
			}
			const res = await fetch("/api/content-items/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error("Bulk rename failed");
			const result = await res.json();
			setToast({
				msg: `Renamed ${result.affected} items`,
				type: "success",
				show: true,
			});
			setIsBulkRenameOpen(false);
			setBulkRenamePrefix("");
			setSelectedIds([]);
			setSelectionOrder([]);
			setSelectAllServer(false);
			fetchContent(currentFolderId, { keepSelection: true });
		} catch (error) {
			console.error("Rename failed:", error);
			setToast({ msg: "Failed to rename items", type: "error", show: true });
		} finally {
			setBulkLoading(false);
		}
	}, [
		bulkRenamePrefix,
		selectionOrder,
		selectAllServer,
		buildFilterParams,
		currentFolderId,
		fetchContent,
	]);

	const deleteItem = useCallback(
		async (e: React.MouseEvent, item: ContentItem) => {
			e.stopPropagation();
			const message =
				item.type === "carousel_folder"
					? `Delete folder "${item.name}" and ALL its contents? This cannot be undone.`
					: "Delete this item?";

			if (!confirm(message)) return;

			try {
				await doDelete(item);
				fetchContent(currentFolderId, { keepSelection: true });
				// If we deleted selected items, cleanup
				setSelectedIds((prev) => prev.filter((id) => id !== item.id));
				setSelectionOrder((prev) => prev.filter((id) => id !== item.id));
				setToast({ msg: "Item deleted", type: "success", show: true });
			} catch (error) {
				console.error("Delete failed:", error);
				setToast({ msg: "Failed to delete item", type: "error", show: true });
			}
		},
		[currentFolderId, fetchContent],
	);

	// Robust delete function
	const doDelete = async (item: ContentItem) => {
		// If file, delete from storage (best effort — a storage failure must not block the record delete)
		if (item.path) {
			try {
				const storageRes = await fetch(
					`/api/storage?path=${encodeURIComponent(item.path)}`,
					{ method: "DELETE" },
				);
				if (!storageRes.ok) {
					console.warn(
						`Storage delete failed for ${item.path} (${storageRes.status}); file may remain orphaned.`,
					);
				}
			} catch (error) {
				console.warn("Storage delete threw:", error);
			}
		}

		// Use RPC or Client-side recursion?
		// Since we enabled CASCADE in DB, we just need to delete the row.
		// HOWEVER, we should technically delete the storage files of children too.
		// DB won't auto-delete storage files.
		// For a perfectly clean system, we need to fetch all descendants with 'path' != null and delete them from storage.

		if (item.type === "carousel_folder") {
			// Fetch all descendants recursively to clean up storage (Optional but recommended)
			// For this MVP step, we will rely on DB Cascade for record cleanup.
			// Storage orphan cleanup is a maintenance task usually.
			// Implementing full recursive storage cleanup client-side can be slow for large folders.
			// Let's stick to simple record delete for now, noting that files might remain in bucket.
		}

		const res = await fetch(`/api/content-items/${item.id}`, {
			method: "DELETE",
		});
		if (!res.ok) throw new Error("Delete failed");
	};

	const handleRename = async () => {
		// Legacy rename function - redirecting to openEditModal
		if (editingItem) openEditModal([editingItem]);
	};

	const openEditModal = useCallback((items: ContentItem[]) => {
		setItemsToEdit(items);
		setIsEditModalOpen(true);
	}, []);

	const onEditComplete = useCallback(() => {
		fetchContent(currentFolderId, { keepSelection: true });
		setItemsToEdit([]);
	}, [currentFolderId, fetchContent]);

	// Triggered when "Move" is clicked on an item or selection
	const openMoveModal = useCallback((items: ContentItem[]) => {
		setMoveItems(items);
		setIsMoveModalOpen(true);
	}, []);

	const onMoveComplete = useCallback(() => {
		fetchContent(currentFolderId, { keepSelection: true });
		setSelectedIds([]);
		setSelectionOrder([]);
		setSelectAllServer(false);
	}, [currentFolderId, fetchContent]);

	const openImageEditor = useCallback((item: ContentItem) => {
		setImageEditorItem(item);
		setIsImageEditorOpen(true);
	}, []);

	const handleImageEditorSave = useCallback(
		async (dataUrl: string) => {
			if (!imageEditorItem) return;

			try {
				setToast({ msg: "Saving edited image...", type: "info", show: true });

				// Convert DataURL to Blob/File and push through the shared upload
				// queue — the global pipeline handles chunking, retries, resume and
				// server-side UUID naming (no more bespoke chunk loop / Math.random names).
				const res = await fetch(dataUrl);
				const blob = await res.blob();
				const file = new File([blob], `edited_${imageEditorItem.name}`, {
					type: "image/png",
				});
				addFiles([file], currentFolderId);

				setToast({
					msg: "Image saved — uploading",
					type: "success",
					show: true,
				});
				setIsImageEditorOpen(false);
				setImageEditorItem(null);
				// Refresh so the new item appears once the queue completes it.
				fetchContent(currentFolderId, { keepSelection: true });
			} catch (error) {
				console.error("Save failed:", error);
				setToast({
					msg:
						"Failed to save image: " + ((error as Error)?.message || "unknown error"),
					type: "error",
					show: true,
				});
			}
		},
		[imageEditorItem, currentFolderId, addFiles, fetchContent],
	);

	// -------------------------------------------------------------------------
	// Renders
	// -------------------------------------------------------------------------

	// Caluclate all unique tags from current items
	const allTags = useMemo(() => {
		const tags = new Set<string>();
		items.forEach((item) => item.tags?.forEach((t) => tags.add(t)));
		return Array.from(tags).sort();
	}, [items]);

	const sortedItems = useMemo(() => {
		return [...items].sort((a, b) => {
			if (a.type === "carousel_folder" && b.type !== "carousel_folder") return -1;
			if (a.type !== "carousel_folder" && b.type === "carousel_folder") return 1;
			return 0;
		});
	}, [items]);

	const handleSelectAll = useCallback(() => {
		selectionTouchedRef.current = true;
		const allFilteredIds = sortedItems.map((i) => i.id);
		const allSelected = allFilteredIds.every((id) => selectedIds.includes(id));

		if (allSelected || selectAllServer) {
			// Deselect everything
			setSelectedIds([]);
			setSelectionOrder([]);
			setSelectAllServer(false);
		} else {
			// Select all visible ones in order
			const newSet = new Set([...selectedIds, ...allFilteredIds]);
			setSelectedIds(Array.from(newSet));
			const newOrder = [
				...selectionOrder,
				...allFilteredIds.filter((id) => !selectionOrder.includes(id)),
			];
			setSelectionOrder(newOrder);
		}
	}, [sortedItems, selectedIds, selectionOrder, selectAllServer]);

	const handleSelectAllServer = useCallback(() => {
		if (selectAllServer) {
			setSelectAllServer(false);
			setSelectedIds([]);
			setSelectionOrder([]);
		} else {
			// Select all loaded items and set server flag
			const allFilteredIds = sortedItems.map((i) => i.id);
			setSelectedIds(allFilteredIds);
			setSelectionOrder(allFilteredIds);
			setSelectAllServer(true);
		}
	}, [selectAllServer, sortedItems]);

	// Bulk delete handler — uses server-side bulk endpoint
	const handleBulkDelete = useCallback(async () => {
		const count = selectAllServer ? totalCount : selectedIds.length;
		if (count < 1) return;

		// Read-only preflight: ask the server how many NESTED rows the cascade
		// would remove beyond the direct selection, so the confirm warns about
		// the folder blast radius BEFORE the user commits (folders hide their
		// descendants in the UI — a silent wipe is a data-loss surprise).
		let descendants = 0;
		try {
			const preflightBody: {
				action: string;
				all?: boolean;
				filters?: Record<string, string>;
				ids?: string[];
			} = { action: "count_descendants" };
			if (selectAllServer) {
				preflightBody.all = true;
				preflightBody.filters = buildFilterParams();
			} else {
				preflightBody.ids = selectedIds;
			}
			const pre = await fetch("/api/content-items/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(preflightBody),
			});
			if (pre.ok) descendants = (await pre.json())?.descendants || 0;
		} catch {
			// Read-only preflight failed — fall back to the plain confirm.
			descendants = 0;
		}

		const message =
			descendants > 0
				? `Delete ${count} items and ${descendants} nested contents? This cannot be undone.`
				: `Delete ${count} items? This cannot be undone.`;
		if (!confirm(message)) return;
		try {
			setBulkLoading(true);
			const body: {
				action: string;
				all?: boolean;
				filters?: Record<string, string>;
				ids?: string[];
			} = { action: "delete" };
			if (selectAllServer) {
				body.all = true;
				body.filters = buildFilterParams();
			} else {
				body.ids = selectedIds;
			}
			const res = await fetch("/api/content-items/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error("Bulk delete failed");
			const result = await res.json();
			setToast({
				msg:
					result.descendants > 0
						? `Deleted ${result.affected} items and ${result.descendants} nested contents`
						: `Deleted ${result.affected} items`,
				type: "success",
				show: true,
			});
			setSelectedIds([]);
			setSelectionOrder([]);
			setSelectAllServer(false);
			fetchContent(currentFolderId, { keepSelection: true });
		} catch (error) {
			console.error("Bulk delete failed:", error);
			setToast({ msg: "Failed to delete items", type: "error", show: true });
		} finally {
			setBulkLoading(false);
		}
	}, [
		selectAllServer,
		totalCount,
		selectedIds,
		buildFilterParams,
		currentFolderId,
		fetchContent,
	]);

	/**
	 * Open the move flow. With a partial selection it opens the navigable
	 * MoveContentModal; with select-all active it opens an inline destination
	 * picker and moves ALL matching items server-side (all:true + filters).
	 */
	const openBulkMove = useCallback(async () => {
		if (selectAllServer) {
			setBulkMoveTarget(null);
			try {
				const params = new URLSearchParams({
					parent_id: "",
					types: "carousel_folder",
					limit: "500",
				});
				const res = await fetch(`/api/content-items?${params.toString()}`);
				if (res.ok) {
					const json = await res.json();
					const data = json.items || json;
					setMoveFolders((data as ContentItem[]).map(normalizeItem));
				} else {
					setMoveFolders([]);
				}
			} catch {
				setMoveFolders([]);
			}
			setIsBulkMoveOpen(true);
		} else {
			openMoveModal(items.filter((i) => selectedIds.includes(i.id)));
		}
	}, [selectAllServer, items, selectedIds, openMoveModal]);

	const confirmBulkMove = useCallback(async () => {
		try {
			setBulkLoading(true);
			const res = await fetch("/api/content-items/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "move",
					all: true,
					filters: buildFilterParams(),
					data: { parent_id: bulkMoveTarget },
				}),
			});
			if (!res.ok) throw new Error("Bulk move failed");
			const result = await res.json();
			setToast({
				msg: `Moved ${result.affected} items`,
				type: "success",
				show: true,
			});
			setIsBulkMoveOpen(false);
			setBulkMoveTarget(null);
			setSelectedIds([]);
			setSelectionOrder([]);
			setSelectAllServer(false);
			fetchContent(currentFolderId);
		} catch (error) {
			console.error("Bulk move failed:", error);
			setToast({ msg: "Failed to move items", type: "error", show: true });
		} finally {
			setBulkLoading(false);
		}
	}, [bulkMoveTarget, buildFilterParams, currentFolderId, fetchContent]);

	// Handle scroll for infinite loading
	const handleScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			const el = e.currentTarget;
			if (
				el.scrollHeight - el.scrollTop - el.clientHeight < 300 &&
				hasMore &&
				!loadingMore
			) {
				loadMore();
			}
		},
		[hasMore, loadingMore, loadMore],
	);

	// ── Keyboard shortcuts ──────────────────────────────────────────────────────
	// Delete/Backspace → bulk delete selection · Cmd/Ctrl+A → select page ·
	// Escape → clear selection. Ignored while typing in inputs/textareas.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable)
			)
				return;

			if (
				(e.key === "Delete" || e.key === "Backspace") &&
				(selectedIds.length > 0 || selectAllServer)
			) {
				e.preventDefault();
				handleBulkDelete();
			} else if (
				(e.metaKey || e.ctrlKey) &&
				e.key.toLowerCase() === "a" &&
				sortedItems.length > 0
			) {
				e.preventDefault();
				handleSelectAll();
			} else if (e.key === "Escape") {
				setSelectedIds([]);
				setSelectionOrder([]);
				setSelectAllServer(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		selectedIds.length,
		selectAllServer,
		sortedItems.length,
		handleBulkDelete,
		handleSelectAll,
	]);

	// If we are in 'select' mode (Planner), we generally want to return ID of the item.
	// However, if we select a Folder, we might mean "Use this carousel".

	return (
		<div
			className="flex flex-col h-full bg-ios-background relative"
			{...getRootProps()}
		>
			<input {...getInputProps()} />

			{/* Toolbar */}
			<div className="px-4 py-3 border-b border-ios-separator flex flex-col gap-3 bg-ios-background/80 backdrop-blur-md sticky top-0 z-10 transition-all">
				{/* Top Row: Path & Actions */}
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					{/* Breadcrumbs / Back */}
					<div className="flex items-center gap-1 overflow-hidden">
						{currentFolderId ? (
							<div className="flex items-center text-sm font-medium">
								<button
									onClick={() =>
										disableUrlNavigation
											? setInternalFolderId(null)
											: router.push("/content")
									}
									className="hover:bg-black/5 p-1 rounded-md text-ios-secondary hover:text-ios-text transition-colors"
								>
									Library
								</button>
								{folderPath.map((item) => (
									<div key={item.id} className="flex items-center">
										<ChevronRight
											size={14}
											className="text-gray-400 mx-1 flex-shrink-0"
										/>
										<button
											onClick={() =>
												disableUrlNavigation
													? setInternalFolderId(item.id)
													: router.push(`/content?folderId=${item.id}`)
											}
											className="hover:bg-black/5 p-1 rounded-md truncate max-w-[100px] hover:text-ios-text transition-colors"
											title={item.name}
										>
											{item.name}
										</button>
									</div>
								))}
							</div>
						) : (
							<h2 className="text-xl font-bold text-ios-text">Library</h2>
						)}
					</div>

					{/* Selection Actions & Select All */}
					<div className="flex flex-wrap items-center gap-2">
						{/* Sort Dropdown — always visible */}
						<select
							value={sortBy}
							onChange={(e) => setSortBy(e.target.value as SortOption)}
							title="Sort order"
							aria-label="Sort order"
							className="text-xs bg-ios-card border border-ios-separator rounded-lg px-2 py-1.5 focus:border-ios-blue outline-none"
						>
							<option value="name-asc">A→Z</option>
							<option value="name-desc">Z→A</option>
							<option value="created-asc">Oldest</option>
							<option value="created-desc">Newest</option>
						</select>

						{/* Select All / Deselect All Toggle */}
						{sortedItems.length > 0 && (
							<div className="flex items-center gap-1">
								<button
									onClick={handleSelectAll}
									className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
										sortedItems.every((i) => selectedIds.includes(i.id))
											? "bg-ios-blue text-white border-ios-blue"
											: "bg-ios-card border-ios-separator text-ios-blue hover:bg-ios-blue/5"
									}`}
								>
									{selectAllServer
										? `Deselect All`
										: sortedItems.every((i) => selectedIds.includes(i.id))
											? "Deselect All"
											: `Select All`}
								</button>
								{totalCount > items.length &&
									selectedIds.length > 0 &&
									!selectAllServer && (
										<button
											onClick={handleSelectAllServer}
											className="text-xs font-semibold px-3 py-1.5 rounded-lg border bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 transition-all"
										>
											Select All {totalCount}
										</button>
									)}
							</div>
						)}

						{/* Selection Actions */}
						{selectedIds.length > 0 && mode === "manage" && (
							<div className="flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg border border-blue-100 dark:border-blue-900/30">
								<span className="text-xs font-semibold text-ios-blue mr-1">
									{selectedIds.length} selected
								</span>
								{/* Bulk Rename Button */}
								<button
									onClick={() => setIsBulkRenameOpen(true)}
									className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded text-ios-blue"
									title="Rename in Order"
								>
									<TextCursorInput size={14} />
								</button>
								<button
									onClick={openBulkMove}
									className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded text-ios-blue"
									title="Move Selected"
								>
									<Move size={14} />
								</button>
								<button
									onClick={handleBulkDelete}
									disabled={bulkLoading}
									className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-red-500 disabled:opacity-50"
									title="Delete Selected"
								>
									{bulkLoading ? (
										<div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-red-500" />
									) : (
										<Trash2 size={14} />
									)}
								</button>
							</div>
						)}

						{/* Edit Action for Selection */}
						{selectedIds.length > 0 && mode === "manage" && (
							<IOSButton
								variant="secondary"
								onClick={() =>
									openEditModal(items.filter((i) => selectedIds.includes(i.id)))
								}
								className="!py-1.5 !px-3 text-sm flex items-center gap-1"
							>
								<Edit2 size={14} /> Edit
							</IOSButton>
						)}

						<IOSButton
							variant="secondary"
							onClick={() => setIsCreateFolderOpen(true)}
							className="!py-1.5 !px-3 text-sm flex items-center gap-1"
						>
							<Plus size={16} /> Folder
						</IOSButton>

						<IOSButton
							variant="secondary"
							onClick={() => setIsImportModalOpen(true)}
							className="!py-1.5 !px-3 text-sm flex items-center gap-1"
						>
							<Globe size={16} /> Import
						</IOSButton>

						<div className="relative">
							<IOSButton
								variant="primary"
								onClick={() => fileInputRef.current?.click()}
								className="!py-1.5 !px-3 text-sm flex items-center gap-1"
							>
								<Upload size={16} /> Upload
							</IOSButton>
							<input
								ref={fileInputRef}
								id="file-upload"
								type="file"
								multiple
								className="hidden"
								onChange={(e) => {
									if (e.target.files?.length) onDrop(Array.from(e.target.files));
									// Reset so selecting the same file again re-triggers onChange
									e.target.value = "";
								}}
							/>
						</div>
					</div>
				</div>

				{/* Search & Bulk Actions */}
				<div className="relative w-full flex items-center gap-2">
					<div className="relative flex-1">
						<Search
							className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
							size={16}
						/>
						<input
							type="text"
							placeholder="Search name, caption, tags..."
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="w-full bg-ios-card/50 border border-ios-separator rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-ios-blue transition-all"
						/>
					</div>

					{/* Total count badge */}
					{!loading && totalCount > 0 && (
						<span className="text-xs text-ios-secondary bg-ios-card border border-ios-separator px-2.5 py-2 rounded-xl whitespace-nowrap">
							{selectedIds.length > 0
								? `${selectedIds.length} / ${totalCount}`
								: `${totalCount} items`}
						</span>
					)}

					<button
						onClick={() => setShowFilters(!showFilters)}
						className={`p-2 rounded-xl transition-colors ${showFilters ? "bg-ios-blue text-white shadow-sm" : "bg-ios-card border border-ios-separator text-ios-secondary hover:text-ios-text"}`}
					>
						<Filter size={18} />
					</button>
					{/* View Toggle */}
					<div className="flex bg-ios-card/50 rounded-xl border border-ios-separator p-1 gap-1">
						<button
							onClick={() => setViewMode("grid")}
							className={`p-1.5 rounded-lg transition-colors ${viewMode === "grid" ? "bg-ios-blue text-white shadow-sm" : "text-ios-secondary hover:text-ios-text"}`}
							title="Grid View"
						>
							<GridIcon size={16} />
						</button>
						<button
							onClick={() => setViewMode("list")}
							className={`p-1.5 rounded-lg transition-colors ${viewMode === "list" ? "bg-ios-blue text-white shadow-sm" : "text-ios-secondary hover:text-ios-text"}`}
							title="List View"
						>
							<ListIcon size={16} />
						</button>
					</div>
				</div>

				{/* Filter Panel */}
				{showFilters && (
					<div className="animate-in slide-in-from-top-2 fade-in duration-200 bg-ios-card/50 border border-ios-separator rounded-xl p-4 space-y-4">
						<div>
							<span className="text-xs font-medium text-ios-secondary uppercase tracking-wide mb-2 block">
								Include Tags
							</span>
							<div className="flex flex-wrap gap-2">
								{allTags.map((tag) => (
									<button
										key={tag}
										onClick={() => {
											if (filterTags.includes(tag))
												setFilterTags(filterTags.filter((t) => t !== tag));
											else setFilterTags([...filterTags, tag]);
										}}
										className={`text-xs px-2 py-1 rounded-md border transition-colors ${
											filterTags.includes(tag)
												? "bg-ios-blue text-white border-ios-blue"
												: "bg-ios-background border-ios-separator text-ios-secondary hover:border-ios-blue"
										}`}
									>
										{tag}
									</button>
								))}
								{allTags.length === 0 && (
									<span className="text-xs text-gray-400">No tags found.</span>
								)}
							</div>
						</div>

						<div>
							<span className="text-xs font-medium text-ios-secondary uppercase tracking-wide mb-2 block">
								Content Type
							</span>
							<div className="flex flex-wrap gap-2">
								{[
									{ id: "carousel_folder", label: "Folders / Carousels" },
									{ id: "image", label: "Images" },
									{ id: "video", label: "Videos" },
								].map((type) => (
									<button
										key={type.id}
										onClick={() => {
											if (filterTypes.includes(type.id))
												setFilterTypes(filterTypes.filter((t) => t !== type.id));
											else setFilterTypes([...filterTypes, type.id]);
										}}
										className={`text-xs px-2 py-1 rounded-md border transition-colors ${
											filterTypes.includes(type.id)
												? "bg-ios-blue text-white border-ios-blue"
												: "bg-ios-background border-ios-separator text-ios-secondary hover:border-ios-blue"
										}`}
									>
										{type.label}
									</button>
								))}
							</div>
						</div>

						<div>
							<span className="text-xs font-medium text-ios-secondary uppercase tracking-wide mb-2 block">
								Exclude Tags
							</span>
							<div className="flex flex-wrap gap-2">
								{allTags.map((tag) => (
									<button
										key={tag}
										onClick={() => {
											if (excludeTags.includes(tag))
												setExcludeTags(excludeTags.filter((t) => t !== tag));
											else setExcludeTags([...excludeTags, tag]);
										}}
										className={`text-xs px-2 py-1 rounded-md border transition-colors ${
											excludeTags.includes(tag)
												? "bg-red-500 text-white border-red-500"
												: "bg-ios-background border-ios-separator text-ios-secondary hover:border-red-500"
										}`}
									>
										{tag}
									</button>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Drag Overlay */}
			{isDragActive && (
				<div className="absolute inset-0 bg-ios-blue/10 border-2 border-dashed border-ios-blue z-50 flex items-center justify-center backdrop-blur-sm m-4 rounded-xl pointer-events-none">
					<p className="text-ios-blue font-bold text-lg bg-white/80 dark:bg-black/50 px-6 py-3 rounded-full shadow-sm">
						Drop to upload here
					</p>
				</div>
			)}

			{/* Grid */}
			{/* Select All Server Banner */}
			{selectAllServer && (
				<div className="mx-4 mt-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center justify-between">
					<span className="text-sm font-medium text-amber-800 dark:text-amber-200">
						All {totalCount} items in this folder are selected
					</span>
					<button
						onClick={() => {
							setSelectAllServer(false);
							setSelectedIds([]);
							setSelectionOrder([]);
						}}
						className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline"
					>
						Clear selection
					</button>
				</div>
			)}

			<div
				className="flex-1 overflow-y-auto p-4 scroller"
				ref={scrollContainerRef}
				onScroll={handleScroll}
				onDragOver={(e) => {
					if (e.dataTransfer?.types?.includes("text/plain"))
						handleDragOver(e, null, null);
				}}
				onDrop={(e) => {
					if (e.dataTransfer?.types?.includes("text/plain")) handleDrop(e, null);
				}}
			>
				{loading ? (
					<div className="flex justify-center p-12">
						<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
					</div>
				) : fetchError ? (
					<div className="text-center py-20 text-ios-secondary flex flex-col items-center gap-4">
						<div className="w-16 h-16 bg-red-50 dark:bg-red-900/20 rounded-full flex items-center justify-center">
							<AlertCircle size={32} className="text-ios-red" />
						</div>
						<div>
							<p className="font-medium text-lg">Erro ao carregar a biblioteca</p>
							<p className="text-sm mt-1 opacity-70">{fetchError}</p>
						</div>
						<button
							onClick={() => fetchContent(currentFolderId)}
							className="px-4 py-2 bg-ios-blue text-white text-sm font-medium rounded-xl hover:bg-ios-blue/90 transition-colors"
						>
							Tentar novamente
						</button>
					</div>
				) : sortedItems.length === 0 ? (
					<div className="text-center py-20 text-ios-secondary flex flex-col items-center gap-4">
						<div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
							<Folder size={32} className="text-gray-300" />
						</div>
						<div>
							<p className="font-medium text-lg">
								{debouncedSearch ? "Nenhum item encontrado" : "Current folder is empty"}
							</p>
							<p className="text-sm mt-1 opacity-70">
								{debouncedSearch
									? `Nada corresponde a "${debouncedSearch}". Tente outro termo ou limpe a busca.`
									: "Drag and drop files or create a new folder."}
							</p>
						</div>
						<div className="flex gap-2 mt-2">
							{debouncedSearch ? (
								<IOSButton variant="secondary" onClick={() => setSearch("")}>
									Limpar busca
								</IOSButton>
							) : (
								<IOSButton
									variant="primary"
									onClick={() => fileInputRef.current?.click()}
								>
									Fazer upload
								</IOSButton>
							)}
						</div>
					</div>
				) : viewMode === "list" ? (
					<div className="bg-ios-card border border-ios-separator rounded-xl overflow-hidden shadow-sm">
						<table className="min-w-full">
							{/* Sortable column headers */}
							<thead className="bg-ios-background/80 backdrop-blur-sm sticky top-0 z-10">
								<tr className="border-b border-ios-separator">
									{/* Checkbox select-all */}
									<th scope="col" className="w-10 pl-4 pr-2 py-3">
										<button
											onClick={(e) => {
												e.stopPropagation();
												handleSelectAll();
											}}
											className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
												sortedItems.length > 0 &&
												sortedItems.every((i) => selectedIds.includes(i.id))
													? "bg-ios-blue border-ios-blue text-white"
													: "border-ios-separator hover:border-ios-blue"
											}`}
											title="Select / Deselect All"
										>
											{sortedItems.length > 0 &&
												sortedItems.every((i) => selectedIds.includes(i.id)) && (
													<Check size={12} />
												)}
										</button>
									</th>
									<th
										scope="col"
										className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider cursor-pointer hover:text-ios-text select-none"
										onClick={() =>
											setSortBy((s) => (s === "name-asc" ? "name-desc" : "name-asc"))
										}
									>
										<div className="flex items-center gap-1">
											Name
											{sortBy.startsWith("name") && (
												<span className="text-ios-blue">
													{sortBy === "name-asc" ? "↑" : "↓"}
												</span>
											)}
										</div>
									</th>
									<th
										scope="col"
										className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider hidden sm:table-cell"
									>
										Type
									</th>
									<th
										scope="col"
										className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider hidden md:table-cell"
									>
										Size
									</th>
									<th
										scope="col"
										className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider hidden lg:table-cell"
									>
										Duration
									</th>
									<th
										scope="col"
										className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider cursor-pointer hover:text-ios-text select-none hidden xl:table-cell"
										onClick={() =>
											setSortBy((s) =>
												s === "created-desc" ? "created-asc" : "created-desc",
											)
										}
									>
										<div className="flex items-center gap-1">
											Date
											{sortBy.startsWith("created") && (
												<span className="text-ios-blue">
													{sortBy === "created-asc" ? "↑" : "↓"}
												</span>
											)}
										</div>
									</th>
									<th
										scope="col"
										className="px-3 py-3 text-right text-xs font-semibold text-ios-secondary uppercase tracking-wider"
									>
										Actions
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-ios-separator/50">
								{sortedItems.map((item) => {
									const isSelected = selectedIds.includes(item.id);
									return (
										<tr
											key={item.id}
											onClick={() => {
												if (item.type === "carousel_folder") {
													if (mode === "select" && disableUrlNavigation) {
														toggleSelection(item.id);
													} else {
														disableUrlNavigation
															? setInternalFolderId(item.id)
															: router.push(`/content?folderId=${item.id}`);
													}
												} else {
													toggleSelection(item.id);
												}
											}}
											className={`group cursor-pointer transition-colors duration-100 ${
												isSelected
													? "bg-blue-50 dark:bg-blue-900/15"
													: "hover:bg-ios-background/60"
											}`}
										>
											{/* Checkbox */}
											<td
												className="pl-4 pr-2 py-3 w-10"
												onClick={(e) => {
													e.stopPropagation();
													toggleSelection(item.id);
												}}
											>
												<div
													className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all flex-shrink-0 ${
														isSelected
															? "bg-ios-blue border-ios-blue text-white"
															: "border-ios-separator group-hover:border-ios-blue/50"
													}`}
												>
													{isSelected && <Check size={12} />}
												</div>
											</td>

											{/* Name + thumbnail + meta */}
											<td className="px-3 py-2.5">
												<div className="flex items-center gap-3 min-w-0">
													{/* Thumbnail */}
													<div className="flex-shrink-0 h-12 w-12 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 flex items-center justify-center border border-ios-separator relative">
														{item.type === "carousel_folder" ? (
															item.thumbnail_url ? (
																<>
																	<img
																		src={item.thumbnail_url}
																		loading="lazy"
																		decoding="async"
																		className="w-full h-full object-cover opacity-80"
																		alt=""
																	/>
																	<div className="absolute inset-0 flex items-center justify-center bg-black/20">
																		<Folder size={18} className="text-white drop-shadow" />
																	</div>
																</>
															) : (
																<Folder size={22} className="text-blue-400" />
															)
														) : item.type === "video" ? (
															item.thumbnail_url ? (
																<img
																	loading="lazy"
																	decoding="async"
																	className="w-full h-full object-cover"
																	src={item.thumbnail_url}
																	alt=""
																/>
															) : (
																/* No <video> tag — static placeholder saves RAM/CPU */
																<div className="w-full h-full bg-gray-800 flex items-center justify-center">
																	<Video size={16} className="text-white/60" />
																</div>
															)
														) : (
															<img
																loading="lazy"
																decoding="async"
																className="w-full h-full object-cover"
																src={item.url}
																alt=""
															/>
														)}
													</div>
													{/* Text info */}
													<div className="min-w-0 flex-1">
														<p
															className="text-sm font-medium text-ios-text truncate max-w-xs"
															title={item.name}
														>
															{item.name}
														</p>
														{item.caption && (
															<p
																className="text-xs text-ios-secondary truncate max-w-xs mt-0.5"
																title={item.caption}
															>
																{item.caption}
															</p>
														)}
														{item.tags && item.tags.length > 0 && (
															<div className="flex flex-wrap gap-1 mt-1">
																{item.tags.slice(0, 3).map((tag) => (
																	<span
																		key={tag}
																		className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-ios-blue/10 text-ios-blue font-medium leading-none"
																	>
																		{tag}
																	</span>
																))}
																{item.tags.length > 3 && (
																	<span className="text-[10px] text-ios-secondary">
																		+{item.tags.length - 3}
																	</span>
																)}
															</div>
														)}
													</div>
												</div>
											</td>

											{/* Type badge */}
											<td className="px-3 py-2.5 whitespace-nowrap hidden sm:table-cell">
												<span
													className={`px-2 py-0.5 inline-flex text-xs font-semibold rounded-full ${
														item.type === "video"
															? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
															: item.type === "carousel_folder"
																? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
																: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
													}`}
												>
													{item.type === "carousel_folder"
														? "Carousel"
														: item.type === "video"
															? "Video"
															: "Image"}
												</span>
											</td>

											{/* Size */}
											<td className="px-3 py-2.5 whitespace-nowrap text-sm text-ios-secondary hidden md:table-cell">
												{formatBytes(item.size || 0)}
											</td>

											{/* Duration */}
											<td className="px-3 py-2.5 whitespace-nowrap text-sm text-ios-secondary hidden lg:table-cell">
												{item.duration ? (
													formatTime(item.duration)
												) : (
													<span className="text-ios-separator">—</span>
												)}
											</td>

											{/* Date */}
											<td className="px-3 py-2.5 whitespace-nowrap text-xs text-ios-secondary hidden xl:table-cell">
												{new Date(item.created_at).toLocaleDateString("pt-BR", {
													day: "2-digit",
													month: "short",
													year: "2-digit",
												})}
											</td>

											{/* Actions */}
											<td
												className="px-3 py-2.5 whitespace-nowrap text-right"
												onClick={(e) => e.stopPropagation()}
											>
												{mode === "manage" && (
													<div className="flex items-center justify-end gap-0.5">
														<button
															onClick={(e) => {
																e.stopPropagation();
																openEditModal([item]);
															}}
															className="p-1.5 rounded-lg text-ios-secondary hover:text-ios-blue hover:bg-ios-blue/10 transition-colors"
															title="Edit metadata"
														>
															<Edit2 size={15} />
														</button>
														{item.type === "image" && (
															<button
																onClick={(e) => {
																	e.stopPropagation();
																	openImageEditor(item);
																}}
																className="p-1.5 rounded-lg text-ios-secondary hover:text-violet-500 hover:bg-violet-500/10 transition-colors"
																title="Edit image"
															>
																<Palette size={15} />
															</button>
														)}
														<button
															onClick={(e) => {
																e.stopPropagation();
																openMoveModal([item]);
															}}
															className="p-1.5 rounded-lg text-ios-secondary hover:text-ios-blue hover:bg-ios-blue/10 transition-colors"
															title="Move"
														>
															<Move size={15} />
														</button>
														<button
															onClick={(e) => deleteItem(e, item)}
															className="p-1.5 rounded-lg text-ios-secondary hover:text-red-500 hover:bg-red-500/10 transition-colors"
															title="Delete"
														>
															<Trash2 size={15} />
														</button>
													</div>
												)}
												{mode === "select" && (
													<div
														onClick={() => toggleSelection(item.id)}
														className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-all ${
															isSelected
																? "bg-ios-blue border-ios-blue text-white"
																: "bg-ios-background border-ios-separator text-ios-secondary hover:border-ios-blue hover:text-ios-blue"
														}`}
													>
														{isSelected ? (
															<Check size={12} />
														) : (
															<div className="w-3 h-3 border-2 border-current rounded-sm" />
														)}
														<span className="hidden sm:inline">
															{isSelected ? "Selected" : "Select"}
														</span>
													</div>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>

						{/* Footer: load more */}
						{(loadingMore || (hasMore && !loadingMore)) && (
							<div className="border-t border-ios-separator/50 px-4 py-3 flex items-center justify-between bg-ios-background/50">
								<span className="text-xs text-ios-secondary">
									Showing {items.length} of {totalCount} items
								</span>
								{loadingMore ? (
									<div className="flex items-center gap-2 text-xs text-ios-secondary">
										<div className="animate-spin rounded-full h-4 w-4 border-b-2 border-ios-blue" />
										Loading…
									</div>
								) : (
									<button
										onClick={loadMore}
										className="text-xs font-semibold text-ios-blue hover:underline px-3 py-1.5 rounded-lg hover:bg-ios-blue/5 transition-colors"
									>
										Load more
									</button>
								)}
							</div>
						)}
					</div>
				) : (
					<AutoSizer
						renderProp={({
							height,
							width,
						}: {
							height: number | undefined;
							width: number | undefined;
						}): React.ReactElement => (
							<GridArea
								height={height || 0}
								width={width || 0}
								sortedItems={sortedItems}
								selectedIds={selectedIds}
								dropTargetId={dropTargetId}
								draggedItems={draggedItems}
								mode={mode}
								disableUrlNavigation={disableUrlNavigation}
								hasMore={hasMore}
								loadingMore={loadingMore}
								itemsCount={items.length}
								totalCount={totalCount}
								loadMore={loadMore}
								handleScroll={handleScroll}
								toggleSelection={toggleSelection}
								handleDragStart={handleDragStart}
								handleDragEnd={handleDragEnd}
								handleDragOver={handleDragOver}
								handleDragLeave={handleDragLeave}
								handleDrop={handleDrop}
								setInternalFolderId={setInternalFolderId}
								router={router}
								openEditModal={openEditModal}
								openImageEditor={openImageEditor}
								deleteItem={deleteItem}
								openMoveModal={openMoveModal}
							/>
						)}
					/>
				)}
			</div>

			{/* Rename Dialog (Simple prompt handling via state effect is redundant if we use window.prompt, 
               but if we wanted a custom modal we'd render it here. For now window.prompt in handler is enough 
               but we set state just to track intended target if we were to upgrade UI) */}

			<MoveContentModal
				isOpen={isMoveModalOpen}
				onClose={() => setIsMoveModalOpen(false)}
				itemsToMove={moveItems}
				onMoveComplete={onMoveComplete}
			/>

			<EditContentModal
				isOpen={isEditModalOpen}
				onClose={() => setIsEditModalOpen(false)}
				itemsToEdit={itemsToEdit}
				onEditComplete={onEditComplete}
			/>

			{isImportModalOpen && (
				<ImportUrlModal
					currentFolderId={currentFolderId}
					onClose={() => setIsImportModalOpen(false)}
					onImported={(name) => {
						setToast({
							msg: `${name} importado com sucesso`,
							type: "success",
							show: true,
						});
						fetchContent(currentFolderId);
					}}
				/>
			)}

			{imageEditorItem && (
				<ImageEditorModal
					isOpen={isImageEditorOpen}
					onClose={() => setIsImageEditorOpen(false)}
					imageUrl={imageEditorItem.url || ""}
					onSave={handleImageEditorSave}
				/>
			)}

			{/* Bulk Rename Modal */}
			{isBulkRenameOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="presentation" onClick={()=>setIsBulkRenameOpen(false)}>
					<div role="dialog" aria-modal="true" aria-labelledby="bulk-rename-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-full max-w-md rounded-2xl p-6 shadow-2xl max-h-[85dvh] overflow-y-auto">
						<h3 id="bulk-rename-title" className="text-lg font-semibold text-ios-text mb-4">
							Rename {selectAllServer ? totalCount : selectionOrder.length} Items in
							Order
						</h3>
						<p className="text-sm text-ios-secondary mb-4">
							{selectAllServer
								? `Todos os ${totalCount} itens (com os filtros atuais) serão renomeados como:`
								: "Items will be renamed as:"}{" "}
							<code className="bg-ios-background px-2 py-1 rounded">prefix_001</code>,{" "}
							<code className="bg-ios-background px-2 py-1 rounded">prefix_002</code>,
							etc.
						</p>
						<input
							type="text"
							value={bulkRenamePrefix}
							onChange={(e) => setBulkRenamePrefix(e.target.value)}
							placeholder="Enter prefix (e.g., slide)"
							className="w-full bg-ios-background border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue mb-4"
							autoFocus
						/>
						<div className="flex justify-end gap-2">
							<IOSButton
								variant="secondary"
								onClick={() => {
									setIsBulkRenameOpen(false);
									setBulkRenamePrefix("");
								}}
							>
								Cancel
							</IOSButton>
							<IOSButton
								variant="primary"
								onClick={handleBulkRename}
								disabled={!bulkRenamePrefix.trim()}
							>
								Rename
							</IOSButton>
						</div>
					</div>
				</div>
			)}

			{/* Create Folder Dialog (replaces window.prompt) */}
			{isCreateFolderOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="presentation" onClick={()=>setIsCreateFolderOpen(false)}>
					<div role="dialog" aria-modal="true" aria-labelledby="create-folder-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-full max-w-md rounded-2xl p-6 shadow-2xl max-h-[85dvh] overflow-y-auto">
						<h3 id="create-folder-title" className="text-lg font-semibold text-ios-text mb-4">Nova pasta</h3>
						<input
							type="text"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") createFolder();
							}}
							placeholder="Nome da pasta (ex.: Slide 01)"
							className="w-full bg-ios-background border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue mb-4"
							autoFocus
						/>
						<div className="flex justify-end gap-2">
							<IOSButton
								variant="secondary"
								onClick={() => {
									setIsCreateFolderOpen(false);
									setNewFolderName("");
								}}
							>
								Cancelar
							</IOSButton>
							<IOSButton
								variant="primary"
								onClick={createFolder}
								disabled={!newFolderName.trim()}
							>
								Criar
							</IOSButton>
						</div>
					</div>
				</div>
			)}

			{/* Bulk Move Dialog (Select-All destination picker) */}
			{isBulkMoveOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="presentation" onClick={()=>setIsBulkMoveOpen(false)}>
					<div role="dialog" aria-modal="true" aria-labelledby="bulk-move-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-full max-w-md rounded-2xl p-6 shadow-2xl flex flex-col max-h-[85dvh] overflow-y-auto">
						<h3 id="bulk-move-title" className="text-lg font-semibold text-ios-text mb-1">
							Mover {totalCount} itens
						</h3>
						<p className="text-sm text-ios-secondary mb-4">
							Todos os itens com os filtros atuais serão movidos.
						</p>
						<div className="flex-1 overflow-y-auto space-y-1 mb-4">
							<button
								onClick={() => setBulkMoveTarget(null)}
								className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-colors ${bulkMoveTarget === null ? "bg-ios-blue/10 border-ios-blue text-ios-blue" : "border-ios-separator text-ios-text hover:bg-ios-background"}`}
							>
								📁 Raiz da biblioteca
							</button>
							{moveFolders.length === 0 && (
								<p className="text-xs text-ios-secondary px-1">
									Nenhuma pasta encontrada na raiz.
								</p>
							)}
							{moveFolders.map((folder) => (
								<button
									key={folder.id}
									onClick={() => setBulkMoveTarget(folder.id)}
									className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-colors truncate ${bulkMoveTarget === folder.id ? "bg-ios-blue/10 border-ios-blue text-ios-blue" : "border-ios-separator text-ios-text hover:bg-ios-background"}`}
								>
									📁 {folder.name}
								</button>
							))}
						</div>
						<div className="flex justify-end gap-2">
							<IOSButton
								variant="secondary"
								onClick={() => setIsBulkMoveOpen(false)}
								disabled={bulkLoading}
							>
								Cancelar
							</IOSButton>
							<IOSButton
								variant="primary"
								onClick={confirmBulkMove}
								disabled={bulkLoading}
							>
								{bulkLoading ? "Movendo…" : "Mover"}
							</IOSButton>
						</div>
					</div>
				</div>
			)}

			<IOSToast
				message={toast.msg}
				type={toast.type}
				isVisible={toast.show}
				onClose={() => setToast((prev) => ({ ...prev, show: false }))}
			/>
		</div>
	);
}
