// Closes an open menu from outside it: `<div {@attach open && dismiss(close)}>`.
import type { Attachment } from "svelte/attachments";

// A press inside the element is its own business, so a menu's button can sit inside and toggle it.
export function dismiss(close: () => void): Attachment<HTMLElement> {
  return (node) => {
    const onPress = (event: MouseEvent): void => {
      if (!node.contains(event.target as Node)) {
        close();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  };
}
