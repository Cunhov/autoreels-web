"use client";

import {
	useUploadTasks,
	useUploadActions,
	UploadTask,
} from "@/contexts/UploadContext";
import { collectDroppedFiles } from "@/lib/upload-drop";
import { useRef, useState, useCallback } from "react";
import {
	Plus,
	X,
	RotateCcw,
	FileVideo,
	Image as ImageIcon,
	AlertCircle,
	CheckCircle2,
	CloudUpload,
	Tag,
} from "lucide-react";

export default function UploadPage() {
	const { tasks } = useUploadTasks();
	const { addFiles, addFolderFiles, cancelTask, retryTask, clearCompleted } =
		useUploadActions();

	// Tag input state
	const [tags, setTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Drag state
	const [isDragging, setIsDragging] = useState(false);

	// Stats
	const totalTasks = tasks.length;
	const completedTasks = tasks.filter((t) => t.status === "completed").length;
	const errorTasks = tasks.filter((t) => t.status === "error").length;
	const frozenTasks = tasks.filter((t) => t.status === "frozen").length;
	const activeTasks = tasks.filter(
		(t) => t.status === "pending" || t.status === "uploading",
	).length;

	// Global queue progress: bytes sent / bytes total across active tasks
	const { globalSent, globalTotal } = tasks.reduce(
		(acc, t) => {
			if (t.status === "pending" || t.status === "uploading") {
				acc.globalTotal += t.size;
				acc.globalSent +=
					t.totalChunks > 0
						? Math.round((t.currentChunk / t.totalChunks) * t.size)
						: 0;
			}
			return acc;
		},
		{ globalSent: 0, globalTotal: 0 },
	);
	const globalProgress =
		globalTotal > 0 ? Math.round((globalSent / globalTotal) * 100) : 0;

	const addTag = useCallback(() => {
		const trimmed = tagInput.trim().toLowerCase();
		if (trimmed && !tags.includes(trimmed)) {
			setTags((prev) => [...prev, trimmed]);
		}
		setTagInput("");
	}, [tagInput, tags]);

	const removeTag = (tag: string) => {
		setTags((prev) => prev.filter((t) => t !== tag));
	};

	const handleTagKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			addTag();
		}
	};

	const handleFiles = useCallback(
		(files: FileList | File[]) => {
			const fileArray = Array.from(files);
			if (fileArray.length > 0) {
				addFiles(fileArray, null, tags);
			}
		},
		[addFiles, tags],
	);

	const handleFolderFiles = useCallback(
		async (files: FileList | File[]) => {
			const fileArray = Array.from(files);
			if (fileArray.length > 0) {
				await addFolderFiles(fileArray, null, tags);
			}
		},
		[addFolderFiles, tags],
	);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();
			setIsDragging(false);

			// Rebuild folder structure (webkitRelativePath) via the Entry API —
			// Chrome leaves it empty on folder drops, which would flatten
			// carousel folders into loose files.
			const fileArray = await collectDroppedFiles(e.dataTransfer);
			if (fileArray.length === 0) return;

			const hasFolderStructure = fileArray.some(
				(f) => f.webkitRelativePath && f.webkitRelativePath.includes("/"),
			);

			if (hasFolderStructure) {
				await handleFolderFiles(fileArray);
			} else {
				handleFiles(fileArray);
			}
		},
		[handleFiles, handleFolderFiles],
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
	}, []);

	const renderTaskStatus = (task: UploadTask) => {
		switch (task.status) {
			case "completed":
				return (
					<span className="flex items-center gap-1 text-ios-green">
						<CheckCircle2 size={14} /> Completed
					</span>
				);
			case "error":
				return (
					<span className="flex items-center gap-1 text-ios-red">
						<AlertCircle size={14} /> Failed
					</span>
				);
			case "frozen":
				return (
					<span className="flex items-center gap-1 text-ios-orange">
						<RotateCcw size={14} className="animate-spin" /> Retrying
					</span>
				);
			case "uploading":
				return (
					<span className="text-ios-blue animate-pulse">
						Uploading {task.progress}%
					</span>
				);
			case "pending":
				return <span className="text-ios-text-secondary">Queued</span>;
			case "canceled":
				return <span className="text-ios-text-secondary">Canceled</span>;
		}
	};

	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 B";
		const k = 1024,
			sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
	};

	const getProgressWidth = (progress: number) => `${Math.max(2, progress)}%`;

	return (
		<div className="flex-1 overflow-auto bg-ios-background p-6">
			<div className="max-w-4xl mx-auto space-y-6">
				{/* Header */}
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-[28px] font-bold tracking-tight text-ios-text">
							Upload Queue
						</h1>
						<p className="text-[15px] text-ios-text-secondary mt-1">
							{activeTasks} active{activeTasks !== 1 ? "s" : ""} • {frozenTasks}{" "}
							retrying • {errorTasks} failed • {completedTasks} completed
						</p>
					</div>
					{completedTasks > 0 && (
						<button
							onClick={clearCompleted}
							className="text-[14px] text-ios-blue font-medium hover:opacity-80 transition-opacity"
						>
							Clear Completed
						</button>
					)}
				</div>

				{/* Global queue progress bar */}
				{(activeTasks > 0 || globalProgress > 0) && (
					<div className="bg-ios-card dark:bg-[#1C1C1E] border border-ios-separator rounded-2xl p-4 shadow-sm">
						<div className="flex items-center justify-between mb-2">
							<span className="text-[13px] font-semibold text-ios-text-secondary uppercase tracking-wider">
								Queue Progress
							</span>
							<span className="text-[13px] font-semibold text-ios-blue">
								{globalProgress > 0 ? globalProgress : "0"}% ·{" "}
								{formatBytes(globalSent)} / {formatBytes(globalTotal)}
							</span>
						</div>
						<div className="h-2 w-full bg-ios-gray-5 rounded-full overflow-hidden">
							<div
								className="h-full rounded-full transition-all duration-300 bg-ios-blue"
								style={{ width: getProgressWidth(globalProgress) }}
							/>
						</div>
					</div>
				)}

				{/* Upload Area — single drop zone (files + folders) */}
				<div className="bg-ios-card dark:bg-[#1C1C1E] border border-ios-separator rounded-2xl overflow-hidden shadow-sm">
					{/* Drop Zone: drop files/folders OR click to browse files */}
					<div
						onDrop={handleDrop}
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onClick={() => fileInputRef.current?.click()}
						className={`p-8 border-b border-ios-separator cursor-pointer transition-all ${
							isDragging
								? "bg-ios-blue/10 border-ios-blue"
								: "hover:bg-ios-gray-6"
						}`}
					>
						<div className="flex flex-col items-center justify-center text-center">
							<CloudUpload
								size={40}
								className={`mb-3 ${isDragging ? "text-ios-blue" : "text-ios-text-secondary opacity-50"}`}
								strokeWidth={1.5}
							/>
							<h3 className="text-[17px] font-semibold text-ios-text mb-1">
								{isDragging
									? "Drop here"
									: "Drag & drop files or folders"}
							</h3>
							<p className="text-[14px] text-ios-text-secondary">
								or{" "}
								<span className="text-ios-blue font-medium">
									click to browse
								</span>{" "}
								— videos & images up to 1GB
							</p>
							<p className="text-[12px] text-ios-text-secondary mt-2">
								Folders with 2+ files become carousels · add a .txt for the
								caption
							</p>
						</div>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							accept="video/*,image/*,.mp4,.mov,.m4v,.webm,.mkv,.jpg,.jpeg,.png,.webp,.gif"
							className="hidden"
							onChange={(e) => {
								if (e.target.files) handleFiles(e.target.files);
								e.target.value = "";
							}}
						/>
					</div>

					{/* Tag Input */}
					<div className="p-4">
						<div className="flex items-center gap-2 mb-2">
							<Tag size={14} className="text-ios-text-secondary" />
							<span className="text-[13px] font-semibold text-ios-text-secondary uppercase tracking-wider">
								Tags for next upload
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-2 mb-3">
							{tags.map((tag) => (
								<span
									key={tag}
									className="inline-flex items-center gap-1 px-2.5 py-1 bg-ios-blue/10 text-ios-blue text-[13px] font-medium rounded-lg"
								>
									{tag}
									<button
										onClick={() => removeTag(tag)}
										className="hover:text-ios-red transition-colors"
										title={`Remove tag "${tag}"`}
									>
										<X size={12} />
									</button>
								</span>
							))}
						</div>
						<div className="flex gap-2">
							<input
								type="text"
								value={tagInput}
								onChange={(e) => setTagInput(e.target.value)}
								onKeyDown={handleTagKeyDown}
								placeholder="Type a tag and press Enter..."
								className="flex-1 px-3 py-2 text-[14px] bg-ios-background border border-ios-separator rounded-xl text-ios-text placeholder:text-ios-text-secondary/50 focus:outline-none focus:ring-2 focus:ring-ios-blue/30 focus:border-ios-blue transition-all"
							/>
							<button
								onClick={addTag}
								disabled={!tagInput.trim()}
								className="px-4 py-2 bg-ios-blue text-white text-[14px] font-medium rounded-xl hover:bg-ios-blue/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1"
								title="Add tag"
							>
								<Plus size={16} /> Add
							</button>
						</div>
					</div>
				</div>

				{/* Queue List */}
				<div className="bg-ios-card dark:bg-[#1C1C1E] border border-ios-separator rounded-2xl overflow-hidden shadow-sm">
					{totalTasks === 0 ? (
						<div className="p-12 text-center flex flex-col items-center justify-center text-ios-text-secondary">
							<CloudUpload
								size={48}
								className="mb-4 opacity-50"
								strokeWidth={1.5}
							/>
							<h3 className="text-[17px] font-semibold text-ios-text mb-1">
								Queue is empty
							</h3>
							<p className="text-[14px]">
								Drop files above or use the Library to start uploading.
							</p>
						</div>
					) : (
						<div className="divide-y divide-ios-separator">
							{tasks.map((task) => (
								<div
									key={task.id}
									className="p-4 hover:bg-ios-gray-6 transition-colors group"
								>
									<div className="flex items-center gap-4">
										{/* Icon */}
										<div className="w-12 h-12 rounded-xl bg-ios-gray-5 flex items-center justify-center text-ios-text flex-shrink-0">
											{task.name.match(/\.(mp4|mov|mkv|webm|m4v)$/i) ? (
												<FileVideo size={24} className="opacity-70" />
											) : (
												<ImageIcon size={24} className="opacity-70" />
											)}
										</div>

										{/* Info */}
										<div className="flex-1 min-w-0">
											<div className="flex justify-between items-start mb-1">
												<h4 className="text-[15px] font-semibold text-ios-text truncate pr-4">
													{task.name}
												</h4>
												<div className="text-[13px] font-medium flex-shrink-0">
													{renderTaskStatus(task)}
												</div>
											</div>

											<div className="flex items-center text-[13px] text-ios-text-secondary gap-3 mb-1">
												<span>{formatBytes(task.size)}</span>
												<span className="w-1 h-1 rounded-full bg-ios-separator"></span>
												<span>
													Dest: {task.folderPath ? task.folderPath : "/"}
												</span>
												{task.forceType === "carousel_item" && (
													<>
														<span className="w-1 h-1 rounded-full bg-ios-separator"></span>
														<span className="text-ios-blue font-medium">
															Carousel Item
														</span>
													</>
												)}
											</div>

											{/* Tags */}
											{task.tags.length > 0 && (
												<div className="flex flex-wrap gap-1 mb-1.5">
													{task.tags.map((tag) => (
														<span
															key={tag}
															className="px-1.5 py-0.5 bg-ios-blue/10 text-ios-blue text-[11px] font-medium rounded"
														>
															{tag}
														</span>
													))}
												</div>
											)}

											{/* Progress Bar */}
											{task.status !== "canceled" &&
												task.status !== "completed" && (
													<div className="h-1.5 w-full bg-ios-gray-5 rounded-full overflow-hidden">
														<div
															className={`h-full rounded-full transition-all duration-300 ${
																task.status === "frozen" ||
																task.status === "error"
																	? "bg-ios-orange"
																	: "bg-ios-blue"
															}`}
															style={{ width: getProgressWidth(task.progress) }}
														/>
													</div>
												)}

											{/* Error Message */}
											{(task.status === "error" || task.status === "frozen") &&
												task.errorMessage && (
													<p className="text-[12px] text-ios-orange mt-1">
														{task.errorMessage}
													</p>
												)}
										</div>

										{/* Controls */}
										<div className="flex items-center gap-2 pl-4">
											{(task.status === "error" ||
												task.status === "frozen" ||
												task.status === "canceled") && (
												<button
													onClick={() => retryTask(task.id)}
													className="w-8 h-8 rounded-full bg-ios-gray-6 flex items-center justify-center text-ios-text hover:bg-ios-gray-5 transition-colors"
													title="Retry Upload"
												>
													<RotateCcw size={16} />
												</button>
											)}

											{(task.status === "pending" ||
												task.status === "uploading" ||
												task.status === "frozen" ||
												task.status === "error") && (
												<button
													onClick={() => cancelTask(task.id)}
													className="w-8 h-8 rounded-full bg-ios-gray-6 flex items-center justify-center text-ios-red hover:bg-ios-red/10 transition-colors"
													title="Cancel Upload"
												>
													<X size={16} />
												</button>
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
