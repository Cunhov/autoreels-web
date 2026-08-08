/**
 * Teste unitário do collectDroppedFiles (lib/upload-drop.ts)
 * Simula a Entry API (webkitGetAsEntry) com mocks.
 */
import { collectDroppedFiles } from "../lib/upload-drop";

// ── Mocks ────────────────────────────────────────────────────────────────
type MockEntry = {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (cb: (f: File) => void) => void;
	createReader?: () => { readEntries: (cb: (e: MockEntry[]) => void) => void };
};

function fileEntry(name: string): MockEntry {
	return {
		isFile: true,
		isDirectory: false,
		name,
		file: (cb) => cb(new File(["x"], name)),
	};
}

function dirEntry(name: string, children: MockEntry[]): MockEntry {
	return {
		isFile: false,
		isDirectory: true,
		name,
		createReader: () => {
			let called = false;
			return {
				// readEntries: primeira chamada entrega tudo, segunda vazio (fim)
				readEntries: (cb: (e: MockEntry[]) => void) => {
					if (!called) {
						called = true;
						cb(children);
					} else {
						cb([]);
					}
				},
			};
		},
	};
}

function fakeDataTransfer(entries: MockEntry[]): DataTransfer {
	return {
		items: entries.map((e) => ({
			webkitGetAsEntry: () => e,
		})),
		files: [],
	} as unknown as DataTransfer;
}

// ── Testes ───────────────────────────────────────────────────────────────
let failures = 0;
function check(label: string, cond: boolean) {
	console.log(`${cond ? "PASS" : "FAIL"} — ${label}`);
	if (!cond) failures++;
}

async function main() {
	// Caso 1: drop de 2 pastas (A com 2 imagens + .DS_Store, B com 1 imagem)
	// O collect retorna TUDO (incluindo junk) — o filtro junk vive no contexto.
	const a = dirEntry("Carousel A", [
		fileEntry("1.jpg"),
		fileEntry("2.jpg"),
		fileEntry(".DS_Store"),
	]);
	const b = dirEntry("Carousel B", [fileEntry("1.jpg")]);
	const r1 = await collectDroppedFiles(fakeDataTransfer([a, b]));
	const p1 = r1.map((f) => f.webkitRelativePath).sort();
	console.log("Caso 1 (2 pastas):", JSON.stringify(p1));
	check("Caso 1: 4 arquivos (junk incluso)", r1.length === 4);

	// Pipeline real: filtro junk (mesma lógica do isJunkUploadFile do contexto)
	const isJunk = (f: File) => {
		const segs = (f.webkitRelativePath || "").split("/");
		return segs.some((s) => s === "__MACOSX" || (s.startsWith(".") && s !== "." && s !== ".."));
	};
	const clean = r1.filter((f) => !isJunk(f));
	const p1c = clean.map((f) => f.webkitRelativePath).sort();
	console.log("Caso 1 (após filtro junk):", JSON.stringify(p1c));
	check(
		"Caso 1: .DS_Store removido + paths corretos",
		JSON.stringify(p1c) ===
			JSON.stringify(
				["Carousel A/1.jpg", "Carousel A/2.jpg", "Carousel B/1.jpg"].sort(),
			),
	);

	// Caso 2: drop de pasta-pai com carrosséis (nested)
	const parent = dirEntry("Uploads", [
		dirEntry("Carousel A", [fileEntry("1.jpg"), fileEntry("2.jpg")]),
		dirEntry("Carousel B", [fileEntry("1.jpg")]),
	]);
	const r2 = await collectDroppedFiles(fakeDataTransfer([parent]));
	const p2 = r2.map((f) => f.webkitRelativePath).sort();
	console.log("Caso 2 (pasta-pai):", JSON.stringify(p2));
	check(
		"Caso 2: paths nested",
		JSON.stringify(p2) ===
			JSON.stringify(
				[
					"Uploads/Carousel A/1.jpg",
					"Uploads/Carousel A/2.jpg",
					"Uploads/Carousel B/1.jpg",
				].sort(),
			),
	);

	// Caso 3: arquivo solto (sem estrutura) — webkitRelativePath fica falsy
	const loose = fileEntry("reel.mp4");
	const r3 = await collectDroppedFiles(fakeDataTransfer([loose]));
	console.log(
		"Caso 3 (arquivo solto):",
		JSON.stringify(r3.map((f) => f.webkitRelativePath)),
	);
	check(
		"Caso 3: arquivo sem path (falsy)",
		r3.length === 1 && !r3[0].webkitRelativePath,
	);

	// Caso 4: sem Entry API → fallback para dataTransfer.files
	const dtNoApi = { items: [], files: [new File(["x"], "plain.jpg")] } as unknown as DataTransfer;
	const r4 = await collectDroppedFiles(dtNoApi);
	check("Caso 4: fallback files", r4.length === 1 && r4[0].name === "plain.jpg");

	console.log(failures === 0 ? "\n✅ TODOS OS TESTES PASSARAM" : `\n❌ ${failures} FALHA(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main();
