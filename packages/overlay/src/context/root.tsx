import { createContext, type ReactNode, useContext } from "react";

export interface RootContextValue {
	/** The overlay's shadow root; Base UI portals render into it. */
	shadowRoot: ShadowRoot;
	/** The host element hosting the shadow root, used by the picker's composedPath guard. */
	host: HTMLElement;
}

const RootContext = createContext<RootContextValue | null>(null);

export function RootProvider({
	shadowRoot,
	host,
	children,
}: RootContextValue & { children: ReactNode }): ReactNode {
	return (
		<RootContext.Provider value={{ shadowRoot, host }}>
			{children}
		</RootContext.Provider>
	);
}

export function useRoot(): RootContextValue {
	const ctx = useContext(RootContext);
	if (!ctx) throw new Error("useRoot must be used within a RootProvider");
	return ctx;
}
