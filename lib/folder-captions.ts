/**
 * folder-captions.ts — leitura das legendas de uma pasta importada.
 *
 * Convenção F4 (dual captions YouTube/Instagram), nome EXATO porém
 * case-insensitive:
 *   - `youtube.txt`      → captionYoutube
 *   - `instagram.txt`    → captionInstagram
 *   - QUALQUER outro `.txt` → caption genérica (fallback p/ ambas plataformas)
 *
 * Vários `.txt` genéricos → o primeiro encontrado (mesmo comportamento do
 * upload pré-dual-captions). Arquivo ausente/falha de leitura → null.
 * Módulo puro (sem React/DOM) para o smoke test importar direto.
 */

export interface FolderCaptions {
    caption: string | null;
    captionYoutube: string | null;
    captionInstagram: string | null;
}

type CaptionFileLike = { name: string; text(): Promise<string> };

export async function readFolderCaptions(
    files: CaptionFileLike[],
): Promise<FolderCaptions> {
    const byLower = new Map<string, CaptionFileLike>(
        files.map((f) => [f.name.toLowerCase(), f]),
    );
    const ytFile = byLower.get("youtube.txt");
    const igFile = byLower.get("instagram.txt");
    // .txt genérico = qualquer arquivo que NÃO seja uma caption por plataforma.
    const genericFile = files.find((f) => {
        const lower = f.name.toLowerCase();
        return (
            lower.endsWith(".txt") &&
            lower !== "youtube.txt" &&
            lower !== "instagram.txt"
        );
    });

    const read = async (
        file: CaptionFileLike | undefined,
    ): Promise<string | null> => {
        if (!file) return null;
        try {
            return (await file.text()) || "";
        } catch (e) {
            console.error("Error reading caption file:", e);
            return null;
        }
    };

    const [caption, captionYoutube, captionInstagram] = await Promise.all([
        read(genericFile),
        read(ytFile),
        read(igFile),
    ]);
    return { caption, captionYoutube, captionInstagram };
}