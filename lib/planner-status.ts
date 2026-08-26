/**
 * BK-34: Union type centralizado para Planner.status.
 * Validação compartilhada entre API e UI.
 */
export const PLANNER_STATUSES = ['active', 'paused', 'failed'] as const;
export type PlannerStatus = typeof PLANNER_STATUSES[number];

export function isPlannerStatus(value: unknown): value is PlannerStatus {
  return typeof value === 'string' && (PLANNER_STATUSES as readonly string[]).includes(value);
}

export function parsePlannerStatus(value: unknown, fallback: PlannerStatus = 'active'): PlannerStatus {
  return isPlannerStatus(value) ? value : fallback;
}

export function assertPlannerStatus(value: unknown): asserts value is PlannerStatus {
  if (!isPlannerStatus(value)) {
    throw new Error(`Invalid planner status: ${String(value)} — expected ${PLANNER_STATUSES.join(' | ')}`);
  }
}
