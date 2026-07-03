import { spawn } from "node:child_process";

interface DirectoryPickerCommandCandidate {
	command: string;
	args: string[];
}

type DirectoryPickerCommandResult =
	| { kind: "selected"; path: string }
	| { kind: "cancelled" }
	| { kind: "unavailable" };

interface RunCommandResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: NodeJS.ErrnoException;
}

type RunCommand = (command: string, args: string[]) => Promise<RunCommandResult>;

interface PickDirectoryPathFromSystemDialogOptions {
	platform?: NodeJS.Platform;
	cwd?: string;
	runCommand?: RunCommand;
}

const WINDOWS_DIRECTORY_PICKER_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	"$dialog.Description = 'Select a project folder'",
	"$dialog.ShowNewFolderButton = $false",
	"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
].join("; ");

function parseChildProcessErrorCode(error: unknown): string | null {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return null;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : null;
}

// GUI pickers (zenity/kdialog/osascript/powershell) stay open until the user picks
// a folder or cancels, which can take a while. spawnSync would block Node's
// single-threaded event loop for that entire wait, freezing the whole runtime
// server (every task, every websocket, every other request) until the dialog is
// dismissed. Use async spawn instead so the picker's own wait doesn't stall
// anything else. A generous timeout still guards the genuine failure mode: no
// display available at all (e.g. a headless session), where these tools hang
// forever instead of erroring — long enough to never fire during normal,
// unhurried folder browsing.
const DIRECTORY_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

function defaultRunCommand(command: string, args: string[]): Promise<RunCommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, DIRECTORY_PICKER_TIMEOUT_MS);

		const settle = (result: RunCommandResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			settle({ stdout, stderr, status: null, signal: null, error });
		});
		child.on("close", (status, signal) => {
			settle({ stdout, stderr, status, signal });
		});
	});
}

async function runDirectoryPickerCommand(
	candidate: DirectoryPickerCommandCandidate,
	runCommand: RunCommand,
): Promise<DirectoryPickerCommandResult> {
	const result = await runCommand(candidate.command, candidate.args);

	const errorCode = parseChildProcessErrorCode(result.error);
	if (errorCode === "ENOENT") {
		return { kind: "unavailable" };
	}

	if (result.error) {
		const message = result.error.message || String(result.error);
		throw new Error(`Could not open directory picker via ${candidate.command}: ${message}`);
	}

	if (result.signal) {
		if (result.signal === "SIGKILL") {
			throw new Error(
				`Could not open directory picker via ${candidate.command}: timed out waiting for a response (no display available?)`,
			);
		}
		throw new Error(`Directory picker command ${candidate.command} terminated by signal: ${result.signal}`);
	}

	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		if (stderr) {
			const stderrLower = stderr.toLowerCase();
			if (stderrLower.includes("user cancel") || stderrLower.includes("(-128)")) {
				return { kind: "cancelled" };
			}
			throw new Error(`Could not open directory picker via ${candidate.command}: ${stderr}`);
		}
		return { kind: "cancelled" };
	}

	const selectedPath = typeof result.stdout === "string" ? result.stdout.trim() : "";
	if (!selectedPath) {
		return { kind: "cancelled" };
	}

	return { kind: "selected", path: selectedPath };
}

export async function pickDirectoryPathFromSystemDialog(
	options: PickDirectoryPathFromSystemDialogOptions = {},
): Promise<string | null> {
	const platform = options.platform ?? process.platform;
	const cwd = options.cwd ?? process.cwd();
	const runCommand = options.runCommand ?? defaultRunCommand;

	if (platform === "darwin") {
		const result = await runDirectoryPickerCommand(
			{
				command: "osascript",
				args: ["-e", 'POSIX path of (choose folder with prompt "Select a project folder")'],
			},
			runCommand,
		);
		if (result.kind === "selected") {
			return result.path;
		}
		if (result.kind === "cancelled") {
			return null;
		}
		throw new Error('Could not open directory picker. Command "osascript" is not available.');
	}

	if (platform === "linux") {
		const candidates: DirectoryPickerCommandCandidate[] = [
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
			{
				command: "kdialog",
				args: ["--getexistingdirectory", cwd, "Select project folder"],
			},
		];

		for (const candidate of candidates) {
			const result = await runDirectoryPickerCommand(candidate, runCommand);
			if (result.kind === "unavailable") {
				continue;
			}
			if (result.kind === "selected") {
				return result.path;
			}
			return null;
		}

		throw new Error('Could not open directory picker. Install "zenity" or "kdialog" and try again.');
	}

	if (platform === "win32") {
		const candidates: DirectoryPickerCommandCandidate[] = [
			{
				command: "powershell",
				args: ["-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
			},
			{
				command: "pwsh",
				args: ["-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
			},
		];

		for (const candidate of candidates) {
			const result = await runDirectoryPickerCommand(candidate, runCommand);
			if (result.kind === "unavailable") {
				continue;
			}
			if (result.kind === "selected") {
				return result.path;
			}
			return null;
		}

		throw new Error('Could not open directory picker. Install PowerShell ("powershell" or "pwsh") and try again.');
	}

	return null;
}
