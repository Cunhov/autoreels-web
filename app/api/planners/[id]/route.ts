import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { escapeHtml } from "@/lib/sanitize";
// Contract with fix3-core: lib/planner-config.ts is created by that worktree.
import { parsePlannerConfig, validatePlannerConfig, validatePlannerChannelMix, PLANNER_MIX_ERROR } from "@/lib/planner-config";
import { propagatePlannerConfigToPendingPosts, shouldPropagateConfig } from "@/lib/planner-runtime";

import { PLANNER_STATUSES, isPlannerStatus } from "@/lib/planner-status";
const VALID_PLANNER_STATUS = [...PLANNER_STATUSES] as const;

function isNotFound(error: unknown): boolean {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2025') {
        return true;
    }
    return error instanceof Error && error.message.includes("P2025");
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const data = await req.json();
        const { channel_ids, config, reset_state, ...rest } = data;

        // Whitelist updatable fields — never allow user_id / id / created_at / state via spread
        const safeRest: Record<string, unknown> = {};
        if (rest.name !== undefined) {
            if (typeof rest.name !== "string" || rest.name.trim().length === 0) {
                return NextResponse.json({ error: "Invalid planner name" }, { status: 400 });
            }
            safeRest.name = rest.name;
        }
        if (rest.status !== undefined) {
            if (!isPlannerStatus(rest.status)) {
                return NextResponse.json({ error: "Invalid planner status" }, { status: 400 });
            }
            safeRest.status = rest.status;
        }

        // Validate config when provided (frequency, sort_order, content, templates, ...)
        let safeConfig: string | undefined;
        if (config !== undefined) {
            const configObj = typeof config === 'string' ? parsePlannerConfig(config) : (config ?? {});
            const validation = validatePlannerConfig(configObj);
            if (validation && validation.ok === false) {
                return NextResponse.json({
                    error: "Invalid planner config",
                    details: Array.isArray(validation.errors) ? validation.errors : ['Invalid planner config'],
                }, { status: 400 });
            }
            safeConfig = JSON.stringify(configObj);
        }

        // channel_ids: must be an array; every id must belong to this user.
        // Empty array is VALID (user explicitly disconnected all channels).
        let safeChannelIds: string[] | undefined;
        let beforeChannelIds: string[] | null = null;
        let oldConfigRaw: string | null = null;
        if (channel_ids !== undefined) {
            if (!Array.isArray(channel_ids)) {
                return NextResponse.json({ error: "channel_ids must be an array" }, { status: 400 });
            }
            if (channel_ids.length > 0) {
                const owned = await prisma.channel.findMany({
                    where: { id: { in: channel_ids }, user_id: userId },
                    select: { id: true },
                });
                if (owned.length !== channel_ids.length) {
                    return NextResponse.json({ error: "One or more channels do not belong to this user" }, { status: 400 });
                }
            }
            // Isolation: bloquear planners mistos YT+IG
            if (channel_ids.length > 1) {
                const mixCheck = await validatePlannerChannelMix(channel_ids, prisma);
                if (!mixCheck.ok) {
                    return NextResponse.json({ error: PLANNER_MIX_ERROR }, { status: 400 });
                }
            }
            safeChannelIds = channel_ids;
            // Captura canais antes da atualização para detectar removidos.
            // Necessário para cancelar Posts órfãos — o publisher busca por
            // Post.channel_id, não por planner.channels, então set() sozinho
            // deixaria posts scheduled/pending órfãos sendo publicados.
            const existing = await prisma.planner.findFirst({
                where: { id, user_id: userId },
                select: { channels: { select: { id: true } }, config: true },
            });
            if (!existing) {
                return NextResponse.json({ error: "Planner not found" }, { status: 404 });
            }
            beforeChannelIds = existing.channels.map(c => c.id);
            oldConfigRaw = (existing as unknown as { config?: string }).config ?? null;
        }

        // Captura config antigo para detectar diff de descrição/título (bug-desc)
        if (safeConfig !== undefined && oldConfigRaw === null) {
            try {
                const prev = await prisma.planner.findFirst({
                    where: { id, user_id: userId },
                    select: { config: true },
                });
                oldConfigRaw = prev?.config ?? null;
            } catch {}
        }
        // Se channel_ids não foi enviado mas safeConfig sim, ainda precisamos do oldConfigRaw
        // (já capturado acima). Se channel_ids foi enviado, o prev já foi buscado para beforeChannelIds,
        // mas não tínhamos oldConfigRaw — buscamos separadamente.

        const planner = await prisma.planner.update({
            where: { id, user_id: userId },
            data: {
                ...safeRest,
                ...(safeConfig !== undefined ? { config: safeConfig } : {}),
                // reset_state: true → clear publish state (used by the wizard when content changed).
                // state is NEVER accepted from the client as a value.
                ...(reset_state === true ? { state: '{}' } : {}),
                ...(safeChannelIds !== undefined ? {
                    channels: {
                        set: safeChannelIds.map(channelId => ({ id: channelId })),
                    },
                } : {}),
            },
        });

        // ── BUG-FIX (track bug-remove): cancelar Posts órfãos de canais removidos ─
        // Comportamento esperado: remover canal = cancela/deleta Posts com status
        // pendente daquele channel_id. Sem isso, o publisher ainda publica pois
        // busca Post por status/channel_id, ignorando planner.channels.
        if (safeChannelIds !== undefined && beforeChannelIds !== null) {
            const afterIds = new Set(safeChannelIds);
            const removedChannelIds = beforeChannelIds.filter(cid => !afterIds.has(cid));
            if (removedChannelIds.length > 0) {
                const cancellableStatuses = [
                    'pending',
                    'scheduled',
                    'queued',
                    'draft',
                    'processing',
                    'processing_upload',
                    'processing_children',
                    'ready_to_publish',
                ];
                try {
                    const result = await prisma.post.updateMany({
                        where: {
                            planner_id: id,
                            channel_id: { in: removedChannelIds },
                            status: { in: cancellableStatuses },
                        },
                        data: {
                            status: 'cancelled',
                            error_message: 'Canal removido do planner',
                            failed_reason: 'channel_removed',
                        },
                    });
                    if (result.count > 0) {
                        await prisma.plannerLog.create({
                            data: {
                                planner_id: id,
                                level: 'info',
                                message: `Canal(is) removido(s) — ${result.count} post(s) cancelado(s)`,
                                details: JSON.stringify({
                                    removed_channel_ids: removedChannelIds,
                                    cancelled_count: result.count,
                                    before: beforeChannelIds,
                                    after: safeChannelIds,
                                }),
                            },
                        });
                    }
                } catch (logErr) {
                    console.error('[planner PATCH] falha ao cancelar posts de canal removido:', logErr);
                    // Não falha o PATCH — a remoção do canal já ocorreu; auditoria apenas.
                    try {
                        await prisma.plannerLog.create({
                            data: {
                                planner_id: id,
                                level: 'warning',
                                message: 'Falha ao cancelar posts de canal removido',
                                details: JSON.stringify({
                                    removed_channel_ids: removedChannelIds,
                                    error: logErr instanceof Error ? logErr.message : String(logErr),
                                }),
                            },
                        });
                    } catch {}
                }
            }
        }

        // ── BUG-FIX (track bug-desc): editar descrição/título propaga para posts pendentes ──
        // COMPORTAMENTO ESPERADO: Editar caption/título do planner (via config) atualiza
        // caption/youtube_options de TODOS os posts pending/scheduled/queued.
        // Posts têm snapshot de caption criado em runPlannerOnce via buildPostData;
        // editar config não propagava — bug reportado.
        if (safeConfig !== undefined) {
            try {
                const oldCfg = oldConfigRaw ? parsePlannerConfig(oldConfigRaw) : {};
                const newCfg = parsePlannerConfig(safeConfig);
                if (shouldPropagateConfig(oldCfg as Record<string, unknown>, newCfg as Record<string, unknown>)) {
                    const { updated, total } = await propagatePlannerConfigToPendingPosts(
                        prisma as unknown as Parameters<typeof propagatePlannerConfigToPendingPosts>[0],
                        { id, user_id: userId },
                        newCfg as Record<string, unknown>,
                        new Date()
                    );
                    if (updated > 0) {
                        console.log(`[planner PATCH] bug-desc: ${updated}/${total} posts propagados para planner ${id}`);
                    }
                }
            } catch (propErr) {
                console.warn("[planner PATCH] falha ao propagar descrição para posts pendentes:", propErr);
                try {
                    await prisma.plannerLog.create({
                        data: {
                            planner_id: id,
                            level: "warning",
                            message: "Falha ao propagar descrição para posts pendentes",
                            details: JSON.stringify({ error: propErr instanceof Error ? propErr.message : String(propErr) }),
                        },
                    });
                } catch {}
            }
        }

        return NextResponse.json(planner);
    } catch (error: unknown) {
        console.error('Update planner error:', error);
        if (isNotFound(error)) {
            return NextResponse.json({ error: "Planner not found" }, { status: 404 });
        }
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        // Hard delete — planner_logs cascade. Manual run / cron history is not archived.
        await prisma.planner.delete({
            where: { id, user_id: userId },
        });
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('Delete planner error:', error);
        if (isNotFound(error)) {
            return NextResponse.json({ error: "Planner not found" }, { status: 404 });
        }
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
