import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

const TERMINAL_SCROLLBACK = 10_000;

// DEC private-mode sequences a well-behaved full-screen TUI (Claude Code, Codex,
// OpenCode, ...) sends when leaving the alternate screen buffer, e.g. on exit.
// xterm.js drops the alternate buffer's cell data once it's deactivated (verified
// against @xterm/headless directly: buffer.alternate comes back with zero lines
// once `1049l` lands), so once one of these arrives there is no way to recover
// the screen the user was actually looking at from the terminal object alone —
// it must be captured going into the transition, not after. 1049 is the modern
// combined form (cursor save/restore + alt screen); 1047/47 are older variants
// some CLIs still emit.
const ALTERNATE_SCREEN_EXIT_SEQUENCES = ["[?1049l", "[?1047l", "[?47l"].map((sequence) =>
	Buffer.from(sequence, "ascii"),
);

function containsAlternateScreenExitSequence(chunk: Uint8Array): boolean {
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	return ALTERNATE_SCREEN_EXIT_SEQUENCES.some((sequence) => buffer.includes(sequence));
}

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
	// Count of PTY chunks already baked into `snapshot`. Callers use this as a
	// cutoff to avoid replaying output that the snapshot already contains.
	sequence: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	private enqueuedCount = 0;
	// The last full-screen snapshot captured while the alternate buffer was still
	// active, taken right before a chunk that leaves it is applied. See
	// ALTERNATE_SCREEN_EXIT_SEQUENCES above for why this can't be reconstructed
	// after the fact.
	private lastAlternateSnapshot: Omit<TerminalRestoreSnapshot, "sequence"> | null = null;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: TERMINAL_SCROLLBACK,
		});
		this.terminal.loadAddon(this.serializeAddon);
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	applyOutput(chunk: Buffer): void {
		const chunkCopy = new Uint8Array(chunk);
		const leavesAlternateScreen = containsAlternateScreenExitSequence(chunkCopy);
		this.enqueuedCount += 1;
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					// Checked here (not at applyOutput call time) so it reflects the
					// terminal's actual state right before this chunk lands, after every
					// earlier queued chunk has already been applied.
					if (leavesAlternateScreen && this.terminal.buffer.active.type === "alternate") {
						this.lastAlternateSnapshot = {
							snapshot: this.serializeAddon.serialize(),
							cols: this.terminal.cols,
							rows: this.terminal.rows,
						};
					}
					this.terminal.write(chunkCopy, () => {
						resolve();
					});
				}),
		);
	}

	// Synchronous chunk counter, incremented in the same call that enqueues the
	// chunk onto the mirror. Callers can read this right after `applyOutput` to
	// stamp a chunk with the exact sequence number `getSnapshot()` will use as
	// its cutoff, without waiting for the write to actually land.
	getOutputSequence(): number {
		return this.enqueuedCount;
	}

	resize(cols: number, rows: number): void {
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		const sequence = this.enqueuedCount;
		await this.operationQueue;
		// Once the session has left the alternate screen (e.g. the agent exited),
		// the live buffer is whatever thin exit message was printed to the normal
		// buffer afterward — the actual screen the user was looking at only
		// survives in the pre-transition capture below.
		if (this.terminal.buffer.active.type === "normal" && this.lastAlternateSnapshot) {
			return { ...this.lastAlternateSnapshot, sequence };
		}
		return {
			snapshot: this.serializeAddon.serialize(),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			sequence,
		};
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
