<script lang="ts">
import type { Snippet } from "svelte";
import type { AppPage } from "../src/pages";
import type { ShellDeck } from "./shell-types";
import Toolbar from "./toolbar.svelte";

interface ShellToolbarProps {
  shell: ShellDeck;
  // The other deck, as a menu row; neither page knows the other's URL.
  otherPage: AppPage;
  clock: boolean;
  controls: Snippet | null;
  composeShareUrl: () => string;
}

// The toolbar as both decks wire it to the shell; what differs between them is the props.
const {
  shell,
  otherPage,
  clock,
  controls,
  composeShareUrl,
}: ShellToolbarProps = $props();
</script>

<Toolbar
  auth={shell.auth}
  pinCount={shell.pinCount}
  city={shell.city}
  refreshingClaims={shell.refreshingClaims}
  {otherPage}
  {clock}
  {controls}
  onSignIn={shell.onSignIn}
  onSignOut={shell.onSignOut}
  onRefreshClaims={shell.onRefreshClaims}
  onAbout={shell.onAbout}
  onSettings={(section) => shell.onSettings(section ?? "")}
  onLogHere={shell.onLogHere}
  logHereDisabled={shell.logHereDisabled}
  logHereBusy={shell.logHereBusy}
  logHereHint={shell.logHereHint}
  onSelectCity={shell.onSelectCity}
  {composeShareUrl}
/>
