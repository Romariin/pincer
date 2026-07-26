/**
 * The overlay follows the OS colour scheme. The class lands on the overlay root
 * inside the shadow tree, so it drives both the token blocks in overlay.css and
 * Tailwind's `dark:` variant (`@custom-variant dark (&:is(.dark *))`).
 */
export function followSystemScheme(node: HTMLElement): () => void {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");

  const apply = (): void => {
    const dark = media?.matches !== false;
    node.classList.toggle("dark", dark);
    node.classList.toggle("light", !dark);
  };

  apply();
  media?.addEventListener("change", apply);
  return () => media?.removeEventListener("change", apply);
}
