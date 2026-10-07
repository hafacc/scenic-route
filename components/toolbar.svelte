<script lang="ts">
import type { Snippet } from "svelte";
import { CITIES, type City } from "../src/cities";
import {
  FiCompass,
  FiCrosshair,
  FiDownload,
  FiInbox,
  FiInfo,
  FiLoader,
  FiLogIn,
  FiLogOut,
  FiMap,
  FiMessageSquare,
  FiRefreshCw,
  FiSliders,
  FiUser,
} from "../src/icons/glyphs";
import type { AppPage } from "../src/pages";
import CityDialog from "./city-dialog.svelte";
import ClockControl from "./clock-control.svelte";
import { dismiss } from "./dismiss";
import FeedbackDialog from "./feedback-dialog.svelte";
import FeedbackInbox from "./feedback-inbox.svelte";
import Icon from "./icon.svelte";
import InstallDialog from "./install-dialog.svelte";
import ShareControl from "./share-control.svelte";
import type { AuthState } from "./shell-types";
import ThemeToggle from "./theme-toggle.svelte";
import { useInstall } from "./use-install.svelte";

interface ToolbarProps {
  auth: AuthState;
  pinCount: number;
  city: City;
  refreshingClaims: boolean;
  controls: Snippet | null;
  // Modes routes at now, so it has no clock.
  clock: boolean;
  // The other deck, as a menu row; neither page knows the other's URL.
  otherPage: AppPage;
  onSignIn: () => void;
  onSignOut: () => void | Promise<void>;
  onRefreshClaims: () => void | Promise<void>;
  onAbout: () => void;
  onSettings: (section?: string) => void;
  onLogHere: () => void;
  logHereDisabled: boolean;
  logHereBusy: boolean;
  logHereHint: string | null;
  onSelectCity: (city: City) => void;
  composeShareUrl: () => string;
}

const MENU_ITEM =
  "flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60";
const MENU_DIVIDER = "border-b border-slate-200/60 dark:border-slate-700/60";

// Whole strings, since a line break inside markup text would reach the DOM.
const NOT_ADMIN =
  "You're signed in, but your account doesn't have admin access yet. Ask an admin to grant you the ";
const NOT_ADMIN_END = " claim.";

function initialFor(email: string | null): string {
  if (!email) {
    return "?";
  }
  const first = email.trim().charAt(0).toUpperCase();
  return first || "?";
}

const {
  auth,
  pinCount,
  city,
  refreshingClaims,
  controls,
  clock,
  otherPage,
  onSignIn,
  onSignOut,
  onRefreshClaims,
  onAbout,
  onSettings,
  onLogHere,
  logHereDisabled,
  logHereBusy,
  logHereHint,
  onSelectCity,
  composeShareUrl,
}: ToolbarProps = $props();

let menuOpen = $state.raw<boolean>(false);
// Read when the menu opens, since routing rewrites the hash without telling anyone.
let menuHash = $state.raw<string>("");
let cityDialogOpen = $state.raw<boolean>(false);
let installHelpOpen = $state.raw<boolean>(false);
let feedbackOpen = $state.raw<boolean>(false);
let inboxOpen = $state.raw<boolean>(false);
const installer = useInstall();

const pinsLogged = $derived(
  pinCount === 1 ? "1 pin logged" : `${pinCount} pins logged`,
);
const signedIn = $derived(auth.kind === "signedIn");
const email = $derived(auth.kind === "signedIn" ? auth.info.user.email : null);
const isAdmin = $derived(auth.kind === "signedIn" && auth.info.admin);

function closeMenu(): void {
  menuOpen = false;
}

function toggleMenu(): void {
  menuHash = window.location.hash;
  menuOpen = !menuOpen;
}

function logHere(): void {
  menuOpen = false;
  onLogHere();
}

function openInbox(): void {
  menuOpen = false;
  inboxOpen = true;
}

function openCityDialog(): void {
  menuOpen = false;
  cityDialogOpen = true;
}

function installApp(): void {
  menuOpen = false;
  void installer.install().then((prompted) => {
    if (!prompted) {
      installHelpOpen = true;
    }
  });
}

function openFeedback(): void {
  menuOpen = false;
  feedbackOpen = true;
}

function openSettings(): void {
  menuOpen = false;
  onSettings();
}

function openAbout(): void {
  menuOpen = false;
  onAbout();
}

function signOut(): void {
  menuOpen = false;
  void onSignOut();
}

function signIn(): void {
  menuOpen = false;
  onSignIn();
}
</script>

<!-- Gap 4px on a phone, where 8px can't fit eight circles; z-1200 clears every z-1000 layer. -->
<div class="absolute top-3 right-3 z-[1200] flex items-center gap-1 sm:gap-2">
  {#if cityDialogOpen}
    <CityDialog
      {city}
      onSelect={onSelectCity}
      onClose={() => (cityDialogOpen = false)}
    />
  {/if}
  {#if installHelpOpen}
    <InstallDialog onClose={() => (installHelpOpen = false)} />
  {/if}
  {#if feedbackOpen}
    <FeedbackDialog onClose={() => (feedbackOpen = false)} />
  {/if}
  {#if inboxOpen}
    <FeedbackInbox onClose={() => (inboxOpen = false)} />
  {/if}
  {@render controls?.()}
  {#if clock}
    <ClockControl />
  {/if}
  <ShareControl composeUrl={composeShareUrl} />
  <ThemeToggle />
  <div {@attach menuOpen && dismiss(closeMenu)} class="relative">
    <button
      type="button"
      onclick={toggleMenu}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={signedIn ? "Account menu" : "Menu"}
      class="grid h-10 w-10 place-items-center rounded-full bg-white/85 text-sm font-semibold text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"
    >
      {#if signedIn}
        <span
          class="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white"
        >
          {initialFor(email)}
        </span>
      {:else}
        <Icon icon={FiUser} class="h-4 w-4" aria-hidden="true" />
      {/if}
    </button>
    {#if menuOpen}
      <div
        role="menu"
        class="toolbar-menu absolute right-0 mt-2 w-72 origin-top-right overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
      >
        {#if signedIn}
          <div class={`px-4 py-3 ${MENU_DIVIDER}`}>
            <p
              class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500"
            >
              Signed in as
            </p>
            <p
              class="mt-0.5 truncate text-sm font-medium text-slate-800 dark:text-slate-100"
            >
              {email ?? "Unknown"}
            </p>
            {#if isAdmin}
              <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {pinsLogged}
              </p>
            {:else}
              <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {NOT_ADMIN}<code>admin</code>{NOT_ADMIN_END}
              </p>
            {/if}
          </div>
        {/if}
        {#if isAdmin}
          <button
            type="button"
            role="menuitem"
            onclick={logHere}
            disabled={logHereDisabled || logHereBusy}
            class={`items-start disabled:opacity-50 ${MENU_ITEM} ${MENU_DIVIDER}`}
          >
            {#if logHereBusy}
              <Icon icon={FiLoader} class="mt-0.5 animate-spin" />
            {:else}
              <Icon icon={FiCrosshair} class="mt-0.5" />
            {/if}
            <span class="flex min-w-0 flex-col">
              <span>{logHereBusy ? "Locating…" : "Log here"}</span>
              {#if !logHereBusy && (logHereHint || logHereDisabled)}
                <span
                  class="mt-0.5 text-xs font-normal text-slate-400 dark:text-slate-500"
                >
                  {logHereHint ?? "Waiting for your location…"}
                </span>
              {/if}
            </span>
          </button>
        {/if}
        {#if isAdmin}
          <button
            type="button"
            role="menuitem"
            onclick={openInbox}
            class={`${MENU_ITEM} ${MENU_DIVIDER}`}
          >
            <Icon icon={FiInbox} />Feedback inbox
          </button>
        {/if}
        {#if signedIn && !isAdmin}
          <button
            type="button"
            role="menuitem"
            onclick={() => void onRefreshClaims()}
            disabled={refreshingClaims}
            class={`disabled:opacity-50 ${MENU_ITEM} ${MENU_DIVIDER}`}
          >
            <Icon
              icon={FiRefreshCw}
              class={refreshingClaims ? "animate-spin" : undefined}
            />Check again
          </button>
        {/if}
        {#if CITIES.length > 1}
          <button
            type="button"
            role="menuitem"
            onclick={openCityDialog}
            class={`justify-between ${MENU_ITEM} ${MENU_DIVIDER}`}
          >
            <span class="flex min-w-0 items-center gap-2">
              <Icon icon={FiMap} class="shrink-0" />Region
            </span>
            <span
              class="ml-auto truncate text-xs font-normal text-slate-400 dark:text-slate-500"
            >
              {city.name}
            </span>
          </button>
        {/if}
        <a
          role="menuitem"
          href={`${otherPage.href}${menuHash}`}
          class={`${MENU_ITEM} ${MENU_DIVIDER}`}
        >
          <Icon icon={FiCompass} />{otherPage.label}
        </a>
        <!-- Other browsers keep install in a menu, so the dialog says where. -->
        {#if installer.installable}
          <button
            type="button"
            role="menuitem"
            onclick={installApp}
            class={`${MENU_ITEM} ${MENU_DIVIDER}`}
          >
            <Icon icon={FiDownload} />
            <span class="flex min-w-0 flex-col">
              <span>Install app</span>
              <span
                class="mt-0.5 text-xs font-normal text-slate-400 dark:text-slate-500"
              >
                Add it to your home screen
              </span>
            </span>
          </button>
        {/if}
        <button
          type="button"
          role="menuitem"
          onclick={openFeedback}
          class={`${MENU_ITEM} ${MENU_DIVIDER}`}
        >
          <Icon icon={FiMessageSquare} />
          <span class="flex min-w-0 flex-col">
            <span>Feedback</span>
            <span
              class="mt-0.5 text-xs font-normal text-slate-400 dark:text-slate-500"
            >
              Tell me about a problem or an idea
            </span>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onclick={openSettings}
          class={`${MENU_ITEM} ${MENU_DIVIDER}`}
        >
          <Icon icon={FiSliders} />Settings
        </button>
        <button
          type="button"
          role="menuitem"
          onclick={openAbout}
          class={MENU_ITEM}
        >
          <Icon icon={FiInfo} />About
        </button>
        {#if signedIn}
          <button
            type="button"
            role="menuitem"
            onclick={signOut}
            class={MENU_ITEM}
          >
            <Icon icon={FiLogOut} />Sign out
          </button>
        {:else}
          <button
            type="button"
            role="menuitem"
            onclick={signIn}
            class={MENU_ITEM}
          >
            <Icon icon={FiLogIn} />Sign in
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
