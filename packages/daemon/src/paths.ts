import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultDataRoot(): string {
	return join(homedir(), ".pincer");
}

export function projectStorageKey(projectRoot: string): string {
	return createHash("sha256").update(realpathSync(projectRoot)).digest("hex");
}

export function projectDataDir(
	projectRoot: string,
	dataRoot = defaultDataRoot(),
): string {
	return join(dataRoot, "projects", projectStorageKey(projectRoot));
}

export function settingsDbPath(dataRoot = defaultDataRoot()): string {
	return join(dataRoot, "settings.db");
}

export interface MigrationFs {
	exists(path: string): boolean;
	mkdir(path: string): void;
	rename(source: string, destination: string): void;
	copy(source: string, destination: string): void;
	remove(path: string): void;
}

export const nodeMigrationFs: MigrationFs = {
	exists: existsSync,
	mkdir(path) {
		mkdirSync(path, { recursive: true });
	},
	rename: renameSync,
	copy(source, destination) {
		cpSync(source, destination, {
			recursive: true,
			errorOnExist: true,
			force: false,
		});
	},
	remove(path) {
		rmSync(path, { recursive: true, force: true });
	},
};

function moveDirectory(
	source: string,
	destination: string,
	fs: MigrationFs,
): void {
	try {
		fs.rename(source, destination);
		return;
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EXDEV"
		)
			throw error;
	}

	const staging = `${destination}.migrating-${process.pid}`;
	fs.remove(staging);
	let committed = false;
	try {
		fs.copy(source, staging);
		fs.rename(staging, destination);
		committed = true;
		fs.remove(source);
	} catch (error) {
		if (!committed) {
			try {
				fs.remove(staging);
			} catch {
				// Preserve the original failure; the source remains authoritative.
			}
		}
		throw error;
	}
}

export function migrateLegacyProjectData(
	projectRoot: string,
	dataRoot: string,
	log: (message: string) => void,
	fs: MigrationFs = nodeMigrationFs,
): void {
	const legacy = join(projectRoot, ".pincer");
	if (!fs.exists(legacy)) return;

	const target = projectDataDir(projectRoot, dataRoot);
	fs.mkdir(dirname(target));
	if (!fs.exists(target)) {
		moveDirectory(legacy, target, fs);
		log(`migrated project data to ${target}`);
		return;
	}

	const archive = join(target, `legacy-project-data-${randomUUID()}`);
	moveDirectory(legacy, archive, fs);
	log(`archived legacy project data at ${archive}`);
}
