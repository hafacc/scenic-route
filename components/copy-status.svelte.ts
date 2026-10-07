// A clipboard write's outcome, shown for a moment and then cleared.
import { onDestroy } from "svelte";

type CopyStatus = "idle" | "copied" | "failed";

const CONFIRM_MS = 2200;

interface Copier {
  readonly status: CopyStatus;
  copy(text: () => string): Promise<void>;
}

// `text` is a getter so a failure to compose it reads as a failed copy.
export function useCopy(): Copier {
  let status = $state.raw<CopyStatus>("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;

  onDestroy(() => clearTimeout(timer));

  return {
    get status() {
      return status;
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text());
        status = "copied";
      } catch {
        status = "failed";
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        status = "idle";
      }, CONFIRM_MS);
    },
  };
}
