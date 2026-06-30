import { useCallback, useEffect, useState } from "react";
import { fetchWorkspaceSkills } from "@/runtime/runtime-config-query";
import type { RuntimeWorkspaceSkill } from "@/runtime/types";

// A tiny stale-while-revalidate cache for the workspace skill list, shared across the
// Settings panel and the per-task picker. Listing is a fast disk read on the runtime, but
// it still crosses a tRPC round-trip; caching it means re-opening "Override Agent Settings"
// is instant instead of re-fetching every time. Mutations (install/remove/create/toggle)
// call `invalidateWorkspaceSkills` so the next read revalidates.

type Skills = RuntimeWorkspaceSkill[];

const LOCAL_KEY = "__local__";
const keyFor = (workspaceId: string | null): string => workspaceId ?? LOCAL_KEY;

const cache = new Map<string, Skills>();
const inflight = new Map<string, Promise<Skills>>();

export function peekWorkspaceSkills(workspaceId: string | null): Skills | undefined {
	return cache.get(keyFor(workspaceId));
}

/** Writes skills into the cache without a fetch — used for optimistic updates. */
export function primeWorkspaceSkills(workspaceId: string | null, skills: Skills): void {
	cache.set(keyFor(workspaceId), skills);
}

export async function loadWorkspaceSkills(
	workspaceId: string | null,
	options: { force?: boolean } = {},
): Promise<Skills> {
	const key = keyFor(workspaceId);
	if (!options.force) {
		const cached = cache.get(key);
		if (cached) {
			return cached;
		}
		const pending = inflight.get(key);
		if (pending) {
			return pending;
		}
	}
	const request = (async () => {
		try {
			const skills = await fetchWorkspaceSkills(workspaceId);
			cache.set(key, skills);
			return skills;
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, request);
	return request;
}

/** Fire-and-forget warm-up so the first picker open is instant. */
export function prefetchWorkspaceSkills(workspaceId: string | null): void {
	void loadWorkspaceSkills(workspaceId).catch(() => {});
}

export async function invalidateWorkspaceSkills(workspaceId: string | null): Promise<Skills> {
	return loadWorkspaceSkills(workspaceId, { force: true });
}

export interface UseWorkspaceSkillsResult {
	skills: Skills;
	isLoading: boolean;
	/** Optimistic local update that also writes through to the shared cache. */
	setSkills: (updater: Skills | ((prev: Skills) => Skills)) => void;
	refetch: () => Promise<Skills>;
}

export function useWorkspaceSkills(workspaceId: string | null, enabled = true): UseWorkspaceSkillsResult {
	const [skills, setSkillsState] = useState<Skills>(() => peekWorkspaceSkills(workspaceId) ?? []);
	const [isLoading, setIsLoading] = useState(false);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		const cached = peekWorkspaceSkills(workspaceId);
		setSkillsState(cached ?? []);
		setIsLoading(cached === undefined);
		loadWorkspaceSkills(workspaceId)
			.then((next) => {
				if (!cancelled) {
					setSkillsState(next);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSkillsState([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, enabled]);

	const setSkills = useCallback(
		(updater: Skills | ((prev: Skills) => Skills)) => {
			setSkillsState((prev) => {
				const next = typeof updater === "function" ? (updater as (p: Skills) => Skills)(prev) : updater;
				primeWorkspaceSkills(workspaceId, next);
				return next;
			});
		},
		[workspaceId],
	);

	const refetch = useCallback(async () => {
		setIsLoading(true);
		try {
			const next = await invalidateWorkspaceSkills(workspaceId);
			setSkillsState(next);
			return next;
		} catch {
			setSkillsState([]);
			return [];
		} finally {
			setIsLoading(false);
		}
	}, [workspaceId]);

	return { skills, isLoading, setSkills, refetch };
}
