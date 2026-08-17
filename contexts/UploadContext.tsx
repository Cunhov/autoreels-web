"use client";

import React, {
	createContext,
	useContext,
	useState,
	useEffect,
	useCallback,
	useRef,
	useMemo,
} from "react";
import { createVideoThumbnailFile } from "@/lib/video-thumbnail";

export type UploadStatus =
	| "pending"
	| "uploading"
	| "frozen"
	| "error"
	| "completed"
	| "canceled";

export interface UploadTask {
	id: string;
	file: File;
	name: string; // sanitized display name
	size: number;
	progress: number;
	status: UploadStatus;
	folderPath: string; // logical folder: 'admin' | 'folder_<id>' | 'carousel_<id>'
	targetPath: string; // relative upload path used by the chunk/status/cancel APIs
	tags: string[];
	parentId?: string | null; // DB parent_id for carousel_item
	forceType?: string | null; // e.g. 'carousel_item'
	caption?: string | null; // caption from .txt file
	errorMessage?: string;
	chunkSize: number;
	totalChunks: number;
	currentChunk: number;
	retryCount: number;
}

export interface UploadAndWaitResult {
	name: string;
	item?: {
		url?: string;
		type?: string;
		thumbnail_url?: string | null;
		[key: string]: unknown;
	} | null;
	error?: string;
}

interface UploadOpts {
	folderId?: string | null;
	tags?: string[];
	forceType?: string | null;
	caption?: string | null;
}

interface UploadActions {
	addFiles: (files: File[], folderId?: string | null, tags?: string[]) => void;
	addFolderFiles: (
		files: File[],
		parentFolderId?: string | null,
		tags?: string[],
	) => Promise<void>;
	cancelTask: (taskId: string) => void;
	retryTask: (taskId: string) => void;
	clearCompleted: () => void;
	uploadAndWait: (
		files: File[],
		opts?: UploadOpts,
	) => Promise<UploadAndWaitResult[]>;
}

interface UploadTasksData {
	tasks: UploadTask[];
	activeUploads: number;
}

export const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks — must match server-side convention
export const MAX_CONCURRENT = 3; // maximum concurrent uploads
export const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB per file
export const VIDEO_EXTS = ["mp4", "mov", "m4v", "webm", "mkv"];
export const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];

const CHUNK_FETCH_TIMEOUT_MS = 60_000; // real per-chunk network timeout (5MB in 60s ≈ 83KB/s floor)
const STATUS_FETCH_TIMEOUT_MS = 30_000; // resume query — never stall the queue on a dead status endpoint
const COMPLETE_FETCH_TIMEOUT_MS = 120_000; // finalize (concat + ffprobe + thumbnail) can legitimately take a while
// 409 "finalize in progress" protocol: while another finalize holds the staging
// lock the server answers 409 { finalizing: true } — wait and re-POST instead of
// erroring out or firing a second concurrent finalize.
const FINALIZE_409_MAX_ATTEMPTS = 5;
const FINALIZE_409_BACKOFF_MS = 1_500;

/** Signal combinado: aborta no cancelamento do usuário OU no timeout. */
function withTimeoutSignal(
	external: AbortSignal,
	timeoutMs: number,
): AbortSignal {
	if (typeof AbortSignal.any === "function") {
		return AbortSignal.any([external, AbortSignal.timeout(timeoutMs)]);
	}
	return external;
}

/** Sleep que rejeita cedo quando o signal de abort dispara. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * POST /api/upload-chunk/complete seguindo o protocolo 409 do contrato:
 * enquanto outro finalize detém o lock de staging, o servidor responde
 * 409 { finalizing: true } — espera e re-POSTa (máx. FINALIZE_409_MAX_ATTEMPTS
 * re-POSTs) em vez de duplicar o finalize ou abortar. Respostas não-409
 * (incluindo a exaustão do backoff) voltam intactas para o caller tratar.
 * O item já-finalizado é reentregue pelo servidor (replay idempotente), então
 * o 200 final resolve tanto finalize fresco quanto replay.
 */
async function finalizeWithRetry(
	formData: FormData,
	signal: AbortSignal,
): Promise<Response> {
	let last: Response | null = null;
	for (let attempt = 0; attempt <= FINALIZE_409_MAX_ATTEMPTS; attempt++) {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (attempt > 0) await sleep(FINALIZE_409_BACKOFF_MS, signal);
		last = await fetch("/api/upload-chunk/complete", {
			method: "POST",
			body: formData,
			signal: withTimeoutSignal(signal, COMPLETE_FETCH_TIMEOUT_MS),
		});
		if (last.status !== 409) return last;
		let finalizing = false;
		try {
			const body = (await last.clone().json()) as { finalizing?: unknown };
			finalizing = body?.finalizing === true;
		} catch {
			/* 409 não-JSON — não é o contrato de finalize-em-progresso: expõe */
		}
		if (!finalizing) return last;
	}
	// Exauriu o backoff: o lock nunca liberou — expõe o último conflito.
	if (last === null) throw new Error("Finalize request failed");
	return last;
}
const FREEZE_TIMEOUT_MS = 30_000; // safety net; the heartbeat keeps slow-but-alive tasks fresh
const HEARTBEAT_INTERVAL_MS = 15_000;
const RETRY_DELAY_MS = 5000;
const MAX_AUTO_RETRIES = 2;

const UploadActionsContext = createContext<UploadActions | undefined>(
	undefined,
);
const UploadTasksContext = createContext<UploadTasksData | undefined>(
	undefined,
);

/** Compat hook — full context (tasks + actions). */
export function useUpload(): UploadTasksData & UploadActions {
	const actions = useContext(UploadActionsContext);
	const tasks = useContext(UploadTasksContext);
	if (!actions || !tasks) {
		throw new Error("useUpload must be used within an UploadProvider");
	}
	return { ...tasks, ...actions };
}

/** Actions only — stable callbacks, does NOT re-render on task progress. */
export function useUploadActions(): UploadActions {
	const actions = useContext(UploadActionsContext);
	if (!actions) {
		throw new Error("useUploadActions must be used within an UploadProvider");
	}
	return actions;
}

/** Tasks only — re-renders when the queue changes. */
export function useUploadTasks(): UploadTasksData {
	const tasks = useContext(UploadTasksContext);
	if (!tasks) {
		throw new Error("useUploadTasks must be used within an UploadProvider");
	}
	return tasks;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[/\\]/g, "-")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
	return cleaned || "untitled";
}

function getFileExtension(name: string): string {
	return name.split(".").pop()?.toLowerCase() || "";
}

function isVideoFile(file: File): boolean {
	// `file.type` pode ser undefined quando o File é sintetizado (ex.:
	// detectContentType passa `{ name } as File`) — nunca quebre no check.
	const type = file.type || "";
	return (
		type.startsWith("video/") ||
		VIDEO_EXTS.includes(getFileExtension(file.name))
	);
}

function isImageFile(file: File): boolean {
	const type = file.type || "";
	return (
		type.startsWith("image/") ||
		IMAGE_EXTS.includes(getFileExtension(file.name))
	);
}

function validateFile(file: File): { ok: boolean; error?: string } {
	if (file.size < 1) {
		return { ok: false, error: "File is empty" };
	}
	if (file.size > MAX_FILE_SIZE) {
		return { ok: false, error: "File too large (max 1GB)" };
	}
	const ext = getFileExtension(file.name);
	if (!isVideoFile(file) && !isImageFile(file)) {
		return { ok: false, error: `Unsupported file type: .${ext || "unknown"}` };
	}
	return { ok: true };
}

function detectContentType(name: string): string {
	return isVideoFile({ name } as File) ? "video" : "image";
}

/**
 * macOS/Windows junk + hidden files — never upload these from folder drops.
 * macOS folders always carry .DS_Store (and zip extracts add __MACOSX/);
 * without this filter every folder upload shows a bogus failed task.
 */
function isJunkUploadFile(file: File): boolean {
	const rel = (file.webkitRelativePath as string) || "";
	const segments = rel ? rel.split("/") : [file.name];
	for (const seg of segments) {
		if (seg === "__MACOSX") return true;
		if (seg.startsWith(".") && seg !== "." && seg !== "..") return true;
	}
	const lower = file.name.toLowerCase();
	return (
		lower === ".ds_store" || lower === "thumbs.db" || lower === "desktop.ini"
	);
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function UploadProvider({ children }: { children: React.ReactNode }) {
	const [tasks, setTasks] = useState<UploadTask[]>([]);
	const [activeUploads, setActiveUploads] = useState<Set<string>>(new Set());

	// Refs (stable, read/written outside React lifecycle)
	const abortControllers = useRef<Map<string, AbortController>>(new Map());
	const lastProgressMs = useRef<Map<string, number>>(new Map());
	const retryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
		new Map(),
	);
	const waiters = useRef<Map<string, (r: UploadAndWaitResult) => void>>(
		new Map(),
	);
	const thumbnails = useRef<Map<string, File>>(new Map());
	const userCanceled = useRef<Set<string>>(new Set());
	const activeUploadsRef = useRef<Set<string>>(new Set());
	const tasksRef = useRef<UploadTask[]>([]);

	// Keep refs in sync for use inside intervals / async flows
	useEffect(() => {
		tasksRef.current = tasks;
	}, [tasks]);
	useEffect(() => {
		activeUploadsRef.current = activeUploads;
	}, [activeUploads]);

	// ── task lifecycle helpers ────────────────────────────────────────────────

	const scheduleRetry = useCallback((taskId: string) => {
		if (retryTimers.current.has(taskId)) return;
		const timer = setTimeout(() => {
			retryTimers.current.delete(taskId);
			setTasks((prev) =>
				prev.map((t) => {
					if (t.id !== taskId || t.status !== "frozen") return t;
					// Keep currentChunk/progress — the next startUpload resumes via
					// the status endpoint instead of restarting from chunk 0.
					// Increment retryCount so auto-retries are bounded.
					return {
						...t,
						status: "pending" as UploadStatus,
						retryCount: t.retryCount + 1,
					};
				}),
			);
		}, RETRY_DELAY_MS);
		retryTimers.current.set(taskId, timer);
	}, []);

	const clearRetryTimer = useCallback((taskId: string) => {
		const timer = retryTimers.current.get(taskId);
		if (timer) {
			clearTimeout(timer);
			retryTimers.current.delete(taskId);
		}
	}, []);

	const resolveWaiter = useCallback(
		(taskId: string, result: UploadAndWaitResult) => {
			const waiter = waiters.current.get(taskId);
			if (waiter) {
				waiters.current.delete(taskId);
				waiter(result);
			}
		},
		[],
	);

	const buildTask = useCallback(
		(
			file: File,
			folderPath: string,
			opts: UploadOpts = {},
			validated: boolean,
		): UploadTask => {
			const safeName = sanitizeFileName(file.name);
			const id = crypto.randomUUID();
			// Staging path ÚNICO por task: o mesmo nome de arquivo na mesma pasta
			// nunca pode compartilhar `.part` — dois uploads concorrentes
			// sobrescreveriam os chunks um do outro e corromperiam o finalize
			// (fonte dos ENOENT/corrupção em produção). O sufixo é só identidade
			// de staging: o nome final do ContentItem vem de `name` (formData
			// "filename"), então a dedupe por nome não muda, e o resume continua
			// funcionando porque o taskId é estável entre retries.
			const targetPath = `${folderPath ? folderPath + "/" : ""}${safeName}.${id.slice(0, 8)}`;
			return {
				id,
				file,
				name: safeName,
				size: file.size,
				progress: 0,
				status: validated
					? ("pending" as UploadStatus)
					: ("error" as UploadStatus),
				folderPath,
				targetPath,
				tags: opts.tags || [],
				parentId: opts.folderId ?? null,
				forceType: opts.forceType ?? null,
				caption: opts.caption ?? null,
				chunkSize: CHUNK_SIZE,
				totalChunks: Math.ceil(file.size / CHUNK_SIZE),
				currentChunk: 0,
				retryCount: 0,
			};
		},
		[],
	);

	// Enqueue tasks. For invalid files, the task is created with status 'error'
	// (visible in the queue with a clear reason) but is NOT enqueued for upload.
	const enqueueTasks = useCallback((newTasks: UploadTask[]) => {
		if (newTasks.length === 0) return;
		for (const t of newTasks) {
			if (t.status === "error") {
				t.errorMessage = t.errorMessage || "Invalid file";
			}
		}
		setTasks((prev) => [...prev, ...newTasks]);
	}, []);

	// ── public actions ────────────────────────────────────────────────────────

	const addFiles = useCallback(
		(files: File[], folderId: string | null = null, tags: string[] = []) => {
			const folderPath = folderId ? `folder_${folderId}` : "admin";
			const newTasks: UploadTask[] = [];
			for (const file of files) {
				// Same rules as folder uploads: OS junk + caption-only .txt files
				// (no folder context) are skipped, never surfaced as failed tasks.
				if (isJunkUploadFile(file)) continue;
				if (file.name.toLowerCase().endsWith(".txt")) continue;
				const check = validateFile(file);
				const task = buildTask(file, folderPath, { folderId, tags }, check.ok);
				if (!check.ok) task.errorMessage = check.error;
				newTasks.push(task);
			}
			enqueueTasks(newTasks);
		},
		[buildTask, enqueueTasks],
	);

	const addFolderFiles = useCallback(
		async (
			files: File[],
			parentFolderId: string | null = null,
			tags: string[] = [],
		) => {
			const newTasks: UploadTask[] = [];

			// ── Group files into carousel folders using webkitRelativePath ──────
			// A group = the DIRECTORY of each file (dirname of the relative path),
			// which handles every nesting shape at once:
			//   • one folder dropped → its direct children form a group
			//   • a parent folder containing carousel subfolders → each subfolder
			//     is its own group
			//   • MULTIPLE folders dropped at once → each top-level folder is its
			//     own group
			//   • MULTIPLE parent folders containing carousel subfolders → each
			//     subfolder is STILL its own group (keying on the root only used to
			//     merge every subfolder of a parent into one carousel — the
			//     user-reported "all slides of all carousels in one folder" bug)
			const folderGroups = new Map<string, File[]>();
			const looseFiles: File[] = [];

			for (const file of files) {
				// Skip OS junk (macOS .DS_Store, hidden files, zip artifacts) —
				// a carousel upload must not fail because of metadata files.
				if (isJunkUploadFile(file)) continue;

				const relPath = file.webkitRelativePath as string;
				if (relPath && relPath.includes("/")) {
					// Key = the folder boundary for this file: its full directory.
					// "Pasta/CarrosselA/1.jpg" → "Pasta/CarrosselA". Distinct paths
					// never collide, so same-named subfolders under different
					// parents stay separate instead of being merged.
					const key = relPath.slice(0, relPath.lastIndexOf("/"));
					if (!folderGroups.has(key)) folderGroups.set(key, []);
					folderGroups.get(key)!.push(file);
				} else {
					looseFiles.push(file);
				}
			}

			const pushMediaTask = (
				file: File,
				folderPath: string,
				opts: UploadOpts,
			) => {
				const check = validateFile(file);
				const task = buildTask(file, folderPath, opts, check.ok);
				if (!check.ok) task.errorMessage = check.error;
				newTasks.push(task);
			};

			// Process folder groups — carousel detection
			for (const [folderKey, groupFiles] of folderGroups) {
				// DB name = the folder's base segment (keys may contain a nested path).
				const folderName = folderKey.split("/").pop() || folderKey;
				let folderCaption = "";
				const txtFile = groupFiles.find((f) =>
					f.name.toLowerCase().endsWith(".txt"),
				);
				if (txtFile) {
					try {
						folderCaption = await txtFile.text();
					} catch (e) {
						console.error("Error reading .txt file:", e);
					}
				}

				const mediaFiles = groupFiles.filter(
					(f) => !f.name.toLowerCase().endsWith(".txt"),
				);
				if (mediaFiles.length === 0) continue;

				if (mediaFiles.length === 1) {
					const file = mediaFiles[0];
					pushMediaTask(
						file,
						parentFolderId ? `folder_${parentFolderId}` : "admin",
						{
							folderId: parentFolderId,
							tags,
							caption: folderCaption || null,
						},
					);
				} else {
					// 2+ files → create carousel_folder in DB, then queue children
					const sortedMedia = [...mediaFiles].sort((a, b) =>
						a.name.localeCompare(b.name, undefined, { numeric: true }),
					);
					try {
						const res = await fetch("/api/content-items", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								name: folderName,
								type: "carousel_folder",
								parent_id: parentFolderId,
								caption: folderCaption || null,
								...(tags.length > 0 ? { tags: JSON.stringify(tags) } : {}),
							}),
						});

						if (!res.ok) throw new Error("Failed to create carousel folder");
						const folderData = await res.json();

						for (const file of sortedMedia) {
							pushMediaTask(file, `carousel_${folderData.id}`, {
								folderId: folderData.id,
								tags,
								forceType: "carousel_item",
							});
						}
					} catch (error) {
						console.error("Error creating carousel folder:", error);
						// Fallback: never drop the media silently — upload the files as
						// individual items so the user still gets their content even if
						// the carousel folder could not be created (e.g. session expiry).
						for (const file of sortedMedia) {
							pushMediaTask(
								file,
								parentFolderId ? `folder_${parentFolderId}` : "admin",
								{
									folderId: parentFolderId,
									tags,
									caption: folderCaption || null,
								},
							);
						}
					}
				}
			}

			// Loose files — individual uploads
			for (const file of looseFiles) {
				if (file.name.toLowerCase().endsWith(".txt")) continue;
				pushMediaTask(
					file,
					parentFolderId ? `folder_${parentFolderId}` : "admin",
					{
						folderId: parentFolderId,
						tags,
					},
				);
			}

			enqueueTasks(newTasks);
		},
		[buildTask, enqueueTasks],
	);

	const cancelTask = useCallback(
		(taskId: string) => {
			clearRetryTimer(taskId);
			userCanceled.current.add(taskId);

			if (abortControllers.current.has(taskId)) {
				abortControllers.current.get(taskId)?.abort();
				abortControllers.current.delete(taskId);
			}

			// Best-effort cleanup of partial chunks on the server (fire-and-forget)
			const task = tasksRef.current.find((t) => t.id === taskId);
			if (task && task.status !== "completed") {
				fetch(`/api/upload-chunk?path=${encodeURIComponent(task.targetPath)}`, {
					method: "DELETE",
				}).catch(() => {
					/* server cleanup is best-effort */
				});
			}

			setTasks((prev) =>
				prev.map((t) => (t.id === taskId ? { ...t, status: "canceled" } : t)),
			);

			resolveWaiter(taskId, { name: task?.name || "", error: "Canceled" });

			setActiveUploads((prev) => {
				const next = new Set(prev);
				next.delete(taskId);
				return next;
			});
		},
		[clearRetryTimer, resolveWaiter],
	);

	const retryTask = useCallback(
		(taskId: string) => {
			clearRetryTimer(taskId);
			setTasks((prev) => {
				const taskToRetry = prev.find((t) => t.id === taskId);
				if (!taskToRetry) return prev;

				const others = prev.filter((t) => t.id !== taskId);
				// Manual retry is a fresh attempt: reset the retry budget but keep
				// chunk progress — startUpload resumes via the status endpoint.
				return [
					...others,
					{
						...taskToRetry,
						status: "pending" as UploadStatus,
						errorMessage: undefined,
						retryCount: 0,
					},
				];
			});
		},
		[clearRetryTimer],
	);

	const clearCompleted = useCallback(() => {
		setTasks((prev) =>
			prev.filter((t) => t.status !== "completed" && t.status !== "canceled"),
		);
	}, []);

	const uploadAndWait = useCallback(
		async (files: File[], opts: UploadOpts = {}) => {
			const results: UploadAndWaitResult[] = [];
			const promises: Promise<UploadAndWaitResult>[] = [];
			const newTasks: UploadTask[] = [];
			const folderPath = opts.folderId ? `folder_${opts.folderId}` : "admin";

			for (const file of files) {
				const check = validateFile(file);
				const task = buildTask(file, folderPath, opts, check.ok);
				if (!check.ok) task.errorMessage = check.error;

				if (check.ok) {
					const promise = new Promise<UploadAndWaitResult>((resolve) => {
						waiters.current.set(task.id, resolve);
					});
					promises.push(promise);
					newTasks.push(task);
				} else {
					results.push({ name: file.name, error: check.error });
				}
			}

			if (newTasks.length > 0) {
				enqueueTasks(newTasks);
				const completed = await Promise.all(promises);
				results.push(...completed);
			}
			return results;
		},
		[buildTask, enqueueTasks],
	);

	// ── Orchestrator Effect ───────────────────────────────────────────────────

	// startUpload is stable via useCallback; it only reads refs + setState.
	const startUpload = useCallback(
		async (task: UploadTask) => {
			setActiveUploads((prev) => new Set(prev).add(task.id));
			setTasks((prev) =>
				prev.map((t) => (t.id === task.id ? { ...t, status: "uploading" } : t)),
			);
			lastProgressMs.current.set(task.id, Date.now());

			const controller = new AbortController();
			abortControllers.current.set(task.id, controller);

			try {
				// Generate the thumbnail BEFORE uploading chunks (fast seek + draw).
				// Failure is non-blocking — the upload proceeds without a thumbnail.
				let thumbFile: File | null = null;
				if (isVideoFile(task.file) && !thumbnails.current.has(task.id)) {
					try {
						thumbFile = await createVideoThumbnailFile(task.file);
						if (thumbFile) thumbnails.current.set(task.id, thumbFile);
					} catch {
						thumbFile = null;
					}
				} else {
					thumbFile = thumbnails.current.get(task.id) || null;
				}

				// Resume support: query which chunks already exist server-side and
				// only re-send the missing ones. First attempt (currentChunk === 0)
				// skips the round-trip.
				let uploadedChunks = new Set<number>();
				if (task.currentChunk > 0 || task.retryCount > 0) {
					try {
						const stRes = await fetch(
							`/api/upload-chunk/status?path=${encodeURIComponent(task.targetPath)}`,
							{
								signal: withTimeoutSignal(
									controller.signal,
									STATUS_FETCH_TIMEOUT_MS,
								),
							},
						);
						if (stRes.ok) {
							const st = await stRes.json();
							if (Array.isArray(st.chunks)) {
								const rawChunks: unknown[] = st.chunks;
								uploadedChunks = new Set(
									rawChunks
										.map((c) => Number(c))
										.filter((n) => Number.isInteger(n)),
								);
							}
						}
					} catch {
						// status query failed — restart from currentChunk
					}
				}

				let currentChunk = task.currentChunk;

				while (currentChunk < task.totalChunks) {
					if (controller.signal.aborted) {
						throw new DOMException("Aborted", "AbortError");
					}

					// Skip chunks already present on the server (resume)
					if (uploadedChunks.has(currentChunk)) {
						currentChunk++;
						const progress = Math.round(
							(currentChunk / task.totalChunks) * 100,
						);
						setTasks((prev) =>
							prev.map((t) =>
								t.id === task.id ? { ...t, currentChunk, progress } : t,
							),
						);
						continue;
					}

					const start = currentChunk * CHUNK_SIZE;
					const end = Math.min(start + CHUNK_SIZE, task.size);
					const chunkBlob = task.file.slice(start, end);

					// Per-chunk controller: aborts on user cancel OR a hard 60s timeout.
					const chunkController = new AbortController();
					const timeoutId = setTimeout(
						() => chunkController.abort(),
						CHUNK_FETCH_TIMEOUT_MS,
					);
					const onTaskAbort = () => chunkController.abort();
					controller.signal.addEventListener("abort", onTaskAbort);

					try {
						lastProgressMs.current.set(task.id, Date.now());

						const response = await fetch("/api/upload-chunk", {
							method: "POST",
							headers: {
								"x-chunk-index": currentChunk.toString(),
								"x-total-chunks": task.totalChunks.toString(),
								"x-file-size": task.size.toString(),
								"x-file-name": task.targetPath,
								"Content-Type": "application/octet-stream",
							},
							body: chunkBlob,
							signal: chunkController.signal,
						});

						// Defensivo: 409 { finalizing: true } num POST de chunk significa
						// que outro finalize detém os parts de staging (não deveria
						// acontecer com paths únicos por task). Pula os chunks restantes
						// e deixa o finalizeWithRetry replar o item do vencedor pelo
						// protocolo de backoff 409.
						if (response.status === 409) {
							let finalizing = false;
							try {
								const body = (await response.clone().json()) as {
									finalizing?: unknown;
								};
								finalizing = body?.finalizing === true;
							} catch {
								/* não-JSON — cai no erro genérico abaixo */
							}
							if (finalizing) {
								currentChunk = task.totalChunks;
								break;
							}
						}

						if (!response.ok) {
							throw new Error(`Server returned ${response.status}`);
						}

						lastProgressMs.current.set(task.id, Date.now());
						currentChunk++;
						const progress = Math.round(
							(currentChunk / task.totalChunks) * 100,
						);
						setTasks((prev) =>
							prev.map((t) =>
								t.id === task.id ? { ...t, currentChunk, progress } : t,
							),
						);
					} catch (chunkError: unknown) {
						if ((chunkError as { name?: string })?.name === "AbortError") {
							if (userCanceled.current.has(task.id)) {
								userCanceled.current.delete(task.id);
								throw chunkError; // user cancel — bail out silently
							}
							// Stall (timeout or freeze-monitor abort) → transient error,
							// the retry path resumes from the status endpoint.
							throw new Error("Connection stalled during chunk upload");
						}
						throw new Error(
							`Chunk ${currentChunk} upload failed. ${(chunkError as Error)?.message || ""}`,
						);
					} finally {
						clearTimeout(timeoutId);
						controller.signal.removeEventListener("abort", onTaskAbort);
					}
				}

				// Finalize: create/update the ContentItem (server generates the UUID name)
				// Contract with /api/upload-chunk/complete: it locates the staged
				// .part files via `path` (the target path), verifies integrity via
				// `size` + `totalChunks`, and accepts the thumbnail as a File.
				const formData = new FormData();
				formData.append("filename", task.name);
				formData.append("size", task.size.toString());
				formData.append("path", task.targetPath);
				formData.append("folderPath", task.folderPath);
				formData.append("totalChunks", task.totalChunks.toString());
				if (task.parentId) formData.append("parentId", task.parentId);
				// forceType wins (e.g. 'carousel_item'); otherwise detect by extension.
				formData.append("type", task.forceType || detectContentType(task.name));
				if (task.tags.length > 0)
					formData.append("tags", JSON.stringify(task.tags));
				if (task.caption) formData.append("caption", task.caption);
				if (thumbFile) formData.append("thumbnail", thumbFile);

				const metaRes = await finalizeWithRetry(formData, controller.signal);

				if (!metaRes.ok) {
					let detail = "";
					try {
						const errBody = await metaRes.json();
						detail = errBody?.error || "";
					} catch {
						/* ignore */
					}
					throw new Error(detail || `Metadata save failed (${metaRes.status})`);
				}

				const data = await metaRes.json();
				const item = data?.item || data;

				thumbnails.current.delete(task.id);
				setTasks((prev) =>
					prev.map((t) =>
						t.id === task.id ? { ...t, status: "completed", progress: 100 } : t,
					),
				);
				resolveWaiter(task.id, { name: task.name, item });
			} catch (error: unknown) {
				const err = error as { name?: string; message?: string };
				if (err.name === "AbortError" && userCanceled.current.has(task.id)) {
					userCanceled.current.delete(task.id);
					return;
				}

				const nextRetryCount = task.retryCount + 1;
				const isFailed = nextRetryCount > MAX_AUTO_RETRIES;

				setTasks((prev) =>
					prev.map((t) =>
						t.id === task.id
							? {
									...t,
									status: isFailed
										? ("error" as UploadStatus)
										: ("frozen" as UploadStatus),
									errorMessage: isFailed
										? `Upload failed: ${err.message || "Unknown error"}`
										: `Upload stalled. Retrying… ${err.message || ""}`,
								}
							: t,
					),
				);

				if (!isFailed) {
					scheduleRetry(task.id);
				} else {
					resolveWaiter(task.id, {
						name: task.name,
						error: err.message || "Upload failed",
					});
				}
			} finally {
				abortControllers.current.delete(task.id);
				lastProgressMs.current.delete(task.id);
				setActiveUploads((prev) => {
					const next = new Set(prev);
					next.delete(task.id);
					return next;
				});
			}
		},
		[resolveWaiter, scheduleRetry],
	);

	// Orchestrator: start pending tasks up to MAX_CONCURRENT
	useEffect(() => {
		const pendingTasks = tasks.filter((t) => t.status === "pending");
		if (activeUploads.size < MAX_CONCURRENT && pendingTasks.length > 0) {
			const tasksToStart = pendingTasks.slice(
				0,
				MAX_CONCURRENT - activeUploads.size,
			);
			tasksToStart.forEach((task) => {
				startUpload(task);
			});
		}
	}, [tasks, activeUploads, startUpload]);

	// Heartbeat: keep slow-but-alive uploads from being flagged as frozen.
	// The real per-chunk timeout (60s) is the actual staleness detector.
	useEffect(() => {
		const interval = setInterval(() => {
			const now = Date.now();
			activeUploadsRef.current.forEach((taskId) => {
				const task = tasksRef.current.find((t) => t.id === taskId);
				if (task && task.status === "uploading") {
					lastProgressMs.current.set(taskId, now);
				}
			});
		}, HEARTBEAT_INTERVAL_MS);
		return () => clearInterval(interval);
	}, []);

	// Freeze Detection safety net (rarely fires thanks to the heartbeat)
	useEffect(() => {
		const interval = setInterval(() => {
			const now = Date.now();
			const frozen: { taskId: string; task: UploadTask }[] = [];

			activeUploads.forEach((taskId) => {
				const task = tasks.find((t) => t.id === taskId);
				if (!task || task.status !== "uploading") return;
				const lastMs = lastProgressMs.current.get(taskId) ?? 0;
				if (now - lastMs > FREEZE_TIMEOUT_MS) {
					frozen.push({ taskId, task });
				}
			});

			if (frozen.length === 0) return;

			setTasks((prev) => {
				let next = prev;
				for (const { taskId, task } of frozen) {
					const nextRetryCount = task.retryCount + 1;
					const isFailed = nextRetryCount > MAX_AUTO_RETRIES;
					next = next.map((t) =>
						t.id === taskId
							? {
									...t,
									status: isFailed
										? ("error" as UploadStatus)
										: ("frozen" as UploadStatus),
									errorMessage: isFailed
										? "Upload failed after multiple retries."
										: "Connection stalled. Retrying…",
								}
							: t,
					);
				}
				return next;
			});

			// Abort the in-flight fetch (NOT a user cancel — the chunk catch maps
			// this to a transient error so the retry resumes from the status endpoint).
			for (const { taskId, task } of frozen) {
				console.warn(`Upload ${taskId} frozen! Aborting and scheduling retry.`);
				if (abortControllers.current.has(taskId)) {
					abortControllers.current.get(taskId)?.abort();
					abortControllers.current.delete(taskId);
				}
				setActiveUploads((prev) => {
					const n = new Set(prev);
					n.delete(taskId);
					return n;
				});
				const nextRetryCount = task.retryCount + 1;
				if (nextRetryCount <= MAX_AUTO_RETRIES) {
					scheduleRetry(taskId);
				} else {
					resolveWaiter(taskId, {
						name: task.name,
						error: "Upload failed after multiple retries.",
					});
				}
			}
		}, 5000);

		return () => clearInterval(interval);
	}, [tasks, activeUploads, scheduleRetry, resolveWaiter]);

	// Cleanup timers on unmount
	useEffect(() => {
		const timers = retryTimers.current;
		return () => {
			timers.forEach((timer) => clearTimeout(timer));
			timers.clear();
		};
	}, []);

	// Warn on page unload while uploads are in flight
	useEffect(() => {
		const handler = (e: BeforeUnloadEvent) => {
			if (activeUploadsRef.current.size > 0) {
				e.preventDefault();
				e.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, []);

	// Memoized value so consumers that only read tasks re-render on queue changes
	// but NOT on every action identity change.
	const tasksValue = useMemo<UploadTasksData>(
		() => ({ tasks, activeUploads: activeUploads.size }),
		[tasks, activeUploads],
	);

	const actionsValue = useMemo<UploadActions>(
		() => ({
			addFiles,
			addFolderFiles,
			cancelTask,
			retryTask,
			clearCompleted,
			uploadAndWait,
		}),
		[
			addFiles,
			addFolderFiles,
			cancelTask,
			retryTask,
			clearCompleted,
			uploadAndWait,
		],
	);

	return (
		<UploadActionsContext.Provider value={actionsValue}>
			<UploadTasksContext.Provider value={tasksValue}>
				{children}
			</UploadTasksContext.Provider>
		</UploadActionsContext.Provider>
	);
}
