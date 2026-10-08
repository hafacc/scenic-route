// Moves an element under `document.body`: `<div {@attach portal}>`.
import type { Attachment } from "svelte/attachments";

// The element must be the only root node of its block, or Svelte's own removal loses its siblings.
export const portal: Attachment<HTMLElement> = (node) => {
  document.body.appendChild(node);
  return () => {
    node.remove();
  };
};
