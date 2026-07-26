import { harnessInfo } from "@/lib/harness";
import { activeCfg } from "./selectors";
import type { PincerStore } from "./storeTypes";
import type { Cfg } from "./thread";
import { daemon } from "./transport";

type Set = (partial: Partial<PincerStore>) => void;
type Get = () => PincerStore;

export function configActions(
	set: Set,
	get: Get,
): Pick<PincerStore, "updateCfg" | "chooseCfgValue"> {
	return {
		updateCfg: (patch) => {
			const state = get();
			if (state.view === "chat" && state.conversationId) {
				const conversationId = state.conversationId;
				const conversation = state.conversations.find(
					(item) => item.id === conversationId,
				);
				const threadState = state.threads[conversationId]?.turnState ?? "idle";
				if (
					!state.connected ||
					state.configPending[conversationId] ||
					conversation?.turnState !== "idle" ||
					threadState !== "idle"
				) {
					return;
				}
				set({
					configPending: { ...state.configPending, [conversationId]: true },
				});
				daemon(state.send).setConfig(conversationId, patch);
			} else {
				set({ draft: { ...state.draft, ...patch } });
			}
		},

		chooseCfgValue: (kind, value) => {
			const state = get();
			const current = activeCfg(state);
			if (kind === "harness") {
				if (!state.harnessMap[value]?.detected) return;
				const patch: Partial<Cfg> = { harnessId: value };
				if (value !== current.harnessId) {
					patch.model = "";
					patch.effort = "";
				}
				state.updateCfg(patch);
			} else if (kind === "model") {
				const info = harnessInfo(state.harnessMap, current.harnessId);
				const model = info.models.find((candidate) => candidate.id === value);
				const patch: Partial<Cfg> = { model: value };
				if (
					model?.efforts &&
					current.effort &&
					!model.efforts.includes(current.effort)
				) {
					patch.effort = "";
				}
				state.updateCfg(patch);
			} else {
				state.updateCfg({ effort: value });
			}
		},
	};
}
