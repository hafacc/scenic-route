<script lang="ts">
import { FirebaseError } from "firebase/app";
import { AuthErrorCodes } from "firebase/auth";
import { sendPasswordReset, signIn } from "../src/firebase";
import { FiLogIn, FiMapPin, FiX } from "../src/icons/glyphs";
import Icon from "./icon.svelte";
import Sheet from "./sheet.svelte";

interface SignInDialogProps {
  onClose: () => void;
}

function describeError(err: unknown): string {
  if (!(err instanceof FirebaseError)) {
    return err instanceof Error ? err.message : "Something went wrong.";
  }
  switch (err.code) {
    case AuthErrorCodes.INVALID_PASSWORD:
    case AuthErrorCodes.USER_DELETED:
    case "auth/invalid-credential":
      return "Invalid email or password.";
    case AuthErrorCodes.INVALID_EMAIL:
      return "That doesn't look like a valid email.";
    case AuthErrorCodes.TOO_MANY_ATTEMPTS_TRY_LATER:
      return "Too many attempts. Try again in a minute.";
    case AuthErrorCodes.NETWORK_REQUEST_FAILED:
      return "Network error. Check your connection.";
    case "auth/missing-email":
      return "Enter your email first.";
    default:
      return err.message;
  }
}

const { onClose }: SignInDialogProps = $props();

let email = $state.raw<string>("");
let password = $state.raw<string>("");
let error = $state.raw<string | null>(null);
let info = $state.raw<string | null>(null);
let isBusy = $state.raw<boolean>(false);
let isResetting = $state.raw<boolean>(false);

const submit = async (event: SubmitEvent) => {
  event.preventDefault();
  error = null;
  info = null;
  isBusy = true;
  try {
    await signIn(email, password);
    onClose();
  } catch (err) {
    error = describeError(err);
    isBusy = false;
  }
};

const handleReset = async () => {
  error = null;
  info = null;
  if (!email) {
    error = "Enter your email first, then tap reset.";
    return;
  }
  isResetting = true;
  try {
    await sendPasswordReset(email);
    // Firebase hides whether the email exists, so show the same message either way.
    info = `If an account exists for ${email}, a reset link is on its way.`;
  } catch (err) {
    error = describeError(err);
  } finally {
    isResetting = false;
  }
};
</script>

<Sheet
  {onClose}
  closeLabel="Close sign in"
  labeledBy="sign-in-title"
  width="md:max-w-sm"
>
  <div class="flex shrink-0 items-start gap-3">
    <span
      class="scenic-logo-pin grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg"
    >
      <Icon icon={FiMapPin} class="h-5 w-5" />
    </span>
    <div class="min-w-0 flex-1">
      <h2 id="sign-in-title" class="text-lg font-semibold tracking-tight">
        Scenic Route
      </h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Sign in to drop and edit pins
      </p>
    </div>
    <button
      type="button"
      onclick={onClose}
      disabled={isBusy}
      class="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
      aria-label="Close"
    >
      <Icon icon={FiX} />
    </button>
  </div>
  <!-- Rows don't shrink and the form scrolls, since a squashed input is worse than a scroll. -->
  <form
    onsubmit={submit}
    class="mt-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain"
  >
    <label class="flex shrink-0 flex-col gap-1 text-sm">
      <span class="font-medium text-slate-600 dark:text-slate-300">Email</span>
      <!-- 16px on a phone: iOS Safari zooms the page on a focused control with smaller text. -->
      <input
        type="email"
        required
        autocomplete="email"
        bind:value={email}
        class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-base outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20 md:text-sm"
      >
    </label>
    <label class="flex shrink-0 flex-col gap-1 text-sm">
      <span class="font-medium text-slate-600 dark:text-slate-300">
        Password
      </span>
      <input
        type="password"
        required
        autocomplete="current-password"
        bind:value={password}
        class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-base outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20 md:text-sm"
      >
    </label>
    {#if error}
      <div
        class="rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100"
      >
        {error}
      </div>
    {/if}
    {#if info}
      <div
        class="rounded-xl bg-emerald-100 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-100"
      >
        {info}
      </div>
    {/if}
    <button
      type="submit"
      disabled={isBusy}
      class="mt-2 inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
    >
      <Icon icon={FiLogIn} />Sign in
    </button>
  </form>
  <button
    type="button"
    onclick={handleReset}
    disabled={isResetting}
    class="mt-4 shrink-0 self-start text-xs text-slate-500 underline-offset-2 hover:text-brand-600 hover:underline disabled:opacity-50 dark:text-slate-400 dark:hover:text-brand-400"
  >
    {isResetting ? "Sending reset link…" : "Forgot password?"}
  </button>
  <p class="mt-4 shrink-0 text-[11px] text-slate-400 dark:text-slate-500">
    Accounts are created by an admin.
  </p>
</Sheet>
