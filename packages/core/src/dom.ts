export interface DomContext {
	tag: string;
	id: string | null;
	classes: string[];
	text: string | null;
	/** `tag#id.class` breadcrumbs from the element up to the root, root-last, max 5. */
	ancestry: string[];
}
