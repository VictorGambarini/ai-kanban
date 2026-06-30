import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";

import { createEnvRow, type EnvRow, findDuplicateEnvKeys, isInvalidEnvKey } from "./agent-env-rows";

interface EnvVarsEditorProps {
	rows: EnvRow[];
	onChange: (rows: EnvRow[]) => void;
	disabled?: boolean;
	/** Copy shown when there are no rows yet. */
	emptyLabel?: string;
	addLabel?: string;
}

const INPUT_CLASS =
	"h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none";

/**
 * Controlled editor for a single set of env assignments. Values are masked by
 * default (they may be secrets) with a per-field reveal toggle. Validation is
 * advisory only — the row util and server both re-normalize on save.
 */
export function EnvVarsEditor({
	rows,
	onChange,
	disabled = false,
	emptyLabel = "No variables configured.",
	addLabel = "Add variable",
}: EnvVarsEditorProps): JSX.Element {
	const [revealedRowIds, setRevealedRowIds] = useState<Set<string>>(new Set());
	const duplicateKeys = findDuplicateEnvKeys(rows);

	const updateRow = (id: string, patch: Partial<Pick<EnvRow, "key" | "value">>): void => {
		onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	};

	const removeRow = (id: string): void => {
		onChange(rows.filter((row) => row.id !== id));
	};

	const toggleReveal = (id: string): void => {
		setRevealedRowIds((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	return (
		<div className="flex flex-col gap-1.5">
			{rows.map((row) => {
				const revealed = revealedRowIds.has(row.id);
				const invalidKey = isInvalidEnvKey(row.key);
				const duplicateKey = duplicateKeys.has(row.key.trim());
				const keyWarning = invalidKey
					? "Use letters, digits, and underscores; cannot start with a digit."
					: duplicateKey
						? "Duplicate name — the last row wins."
						: null;
				return (
					<div key={row.id} className="grid gap-2" style={{ gridTemplateColumns: "1fr 1.5fr auto" }}>
						<div className="flex flex-col gap-0.5">
							<input
								value={row.key}
								onChange={(event) => updateRow(row.id, { key: event.target.value })}
								placeholder="NAME"
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								disabled={disabled}
								aria-label="Variable name"
								aria-invalid={keyWarning ? true : undefined}
								className={cn(INPUT_CLASS, "font-mono", keyWarning && "border-status-orange/60")}
							/>
							{keyWarning ? <span className="text-[11px] text-status-orange">{keyWarning}</span> : null}
						</div>
						<input
							value={row.value}
							onChange={(event) => updateRow(row.id, { value: event.target.value })}
							placeholder="value"
							type={revealed ? "text" : "password"}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							autoComplete="off"
							disabled={disabled}
							aria-label="Variable value"
							className={cn(INPUT_CLASS, "font-mono")}
						/>
						<div className="flex items-center gap-1">
							<Tooltip content={revealed ? "Hide value" : "Reveal value"}>
								<Button
									variant="ghost"
									size="sm"
									icon={revealed ? <EyeOff size={14} /> : <Eye size={14} />}
									aria-label={revealed ? "Hide value" : "Reveal value"}
									onClick={() => toggleReveal(row.id)}
									disabled={disabled}
								/>
							</Tooltip>
							<Button
								variant="ghost"
								size="sm"
								icon={<X size={14} />}
								aria-label="Remove variable"
								onClick={() => removeRow(row.id)}
								disabled={disabled}
							/>
						</div>
					</div>
				);
			})}
			{rows.length === 0 ? <p className="text-text-secondary text-[13px] m-0">{emptyLabel}</p> : null}
			<div>
				<Button
					variant="ghost"
					size="sm"
					icon={<Plus size={14} />}
					onClick={() => onChange([...rows, createEnvRow()])}
					disabled={disabled}
				>
					{addLabel}
				</Button>
			</div>
		</div>
	);
}
