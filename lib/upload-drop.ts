/**
 * Drag & drop de pastas — detecção robusta de estrutura.
 *
 * O Chrome NÃO popula `File.webkitRelativePath` em `dataTransfer.files`
 * quando o usuário arrasta pastas para a página (só o `<input webkitdirectory>`
 * preenche). Sem isso, pastas dropadas viram uma lista plana de arquivos e o
 * agrupamento de carrosséis nunca dispara.
 *
 * Solução: percorrer `dataTransfer.items[i].webkitGetAsEntry()` (FileSystem
 * Entry API) e reconstruir os File objects com `webkitRelativePath` preenchido
 * manualmente. Fallback para `dataTransfer.files` quando a API não existe.
 */

/** Máximo de profundidade na árvore de diretórios (proteção contra loops). */
const MAX_DEPTH = 20;

function defineRelativePath(file: File, relativePath: string): void {
	try {
		Object.defineProperty(file, "webkitRelativePath", {
			value: relativePath,
			configurable: true,
		});
	} catch {
		// Não crítico: o arquivo cai como item avulso.
	}
}

/** `readEntries` entrega no máximo 100 entradas por chamada — drene todas. */
async function readAllEntries(
	reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
	const all: FileSystemEntry[] = [];
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
			reader.readEntries(resolve, reject);
		});
		if (batch.length === 0) return all;
		all.push(...batch);
	}
}

async function readEntry(
	entry: FileSystemEntry,
	basePath: string,
	depth: number,
): Promise<File[]> {
	if (depth > MAX_DEPTH) return [];

	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => {
			(entry as FileSystemFileEntry).file(resolve, reject);
		});
		if (basePath) defineRelativePath(file, `${basePath}/${file.name}`);
		return [file];
	}

	if (entry.isDirectory) {
		const dirEntry = entry as FileSystemDirectoryEntry;
		const children = await readAllEntries(dirEntry.createReader());
		const out: File[] = [];
		for (const child of children) {
			// Path relativo à raiz do drop: "Pasta/...", "Pasta/Sub/..."
			const childBase = basePath
				? `${basePath}/${dirEntry.name}`
				: dirEntry.name;
			out.push(...(await readEntry(child, childBase, depth + 1)));
		}
		return out;
	}

	return [];
}

/**
 * Extrai todos os arquivos de um DataTransfer de drop, reconstruindo a
 * estrutura de pastas quando possível. Se a Entry API não estiver disponível
 * ou nada for produzido, retorna `dataTransfer.files` (comportamento antigo).
 */
export async function collectDroppedFiles(
	dataTransfer: DataTransfer,
): Promise<File[]> {
	const items = dataTransfer.items;
	const hasEntryApi =
		items &&
		items.length > 0 &&
		typeof items[0].webkitGetAsEntry === "function";

	if (!hasEntryApi) {
		return Array.from(dataTransfer.files);
	}

	// IMPORTANTE: DataTransferItem só é válido DURANTE o evento de drop — o
	// browser "tomba" (invalida) os items assim que a primeira operação async
	// (readEntry/file()) é iniciada. Por isso TODAS as entries são capturadas
	// sincronamente primeiro; só depois processamos cada uma. Intercalar o
	// await no loop faz com que apenas a PRIMEIRA pasta seja capturada.
	const entries: FileSystemEntry[] = [];
	for (const item of items) {
		const entry = item.webkitGetAsEntry();
		if (entry) entries.push(entry);
	}

	if (entries.length === 0) {
		return Array.from(dataTransfer.files);
	}

	const collected: File[] = [];
	for (const entry of entries) {
		collected.push(...(await readEntry(entry, "", 0)));
	}
	return collected;
}
