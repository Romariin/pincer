import type { ServerMessage } from "@pincer/core";
import type { Git } from "../git";
import type { InstalledHarness } from "../harnesses/types";
import type { Store } from "../store";

export type Emit = (message: ServerMessage) => void;

export interface OrchestratorDeps {
	git: Git;
	store: Store;
	projectRoot: string;
	pincerDataDir: string;
	harnesses: InstalledHarness[];
	defaultHarnessId: string | null;
	publish: Emit;
	log?: (message: string) => void;
}
