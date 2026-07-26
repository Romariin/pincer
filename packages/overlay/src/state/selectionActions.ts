import { buildDomContext, resolveSource } from "@/dom/picker";
import type { PincerStore, Selection } from "./storeTypes";

type Set = (
	partial:
		| Partial<PincerStore>
		| ((state: PincerStore) => Partial<PincerStore> | PincerStore),
) => void;
type Get = () => PincerStore;

let nextSelectionId = 0;

export function selectionActions(
	set: Set,
	get: Get,
): Pick<PincerStore, "toggleSelect" | "removeSelection" | "clearSelections"> {
	return {
		toggleSelect: (node) => {
			const state = get();
			if (state.selections.some((selection) => selection.domEl === node)) {
				set({
					selections: state.selections.filter(
						(selection) => selection.domEl !== node,
					),
				});
				return;
			}
			nextSelectionId += 1;
			const selection: Selection = {
				id: nextSelectionId,
				domEl: node,
				source: resolveSource(node),
				domContext: buildDomContext(node),
			};
			set({ selections: [...state.selections, selection] });
		},
		removeSelection: (domEl) =>
			set((state) => ({
				selections: state.selections.filter(
					(selection) => selection.domEl !== domEl,
				),
			})),
		clearSelections: () => set({ selections: [] }),
	};
}
