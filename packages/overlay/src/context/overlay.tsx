import { createContext, useContext, type RefObject } from "react";

/**
 * Panel-scoped portal container for overlays (tooltip, picker sheet). Portaling here
 * (instead of the shadow root) keeps them inside the panel's stacking context, above
 * the panel content — the shadow root is a sibling of the max-z-index panel, so a
 * portal there would render behind it.
 */
const OverlayContainerContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export const OverlayContainerProvider = OverlayContainerContext.Provider;

export function useOverlayContainer(): RefObject<HTMLDivElement | null> | null {
  return useContext(OverlayContainerContext);
}
