<script lang="ts">
interface Props {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}

const TRACK =
  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition";
const TRACK_ON = "bg-brand-500";
const TRACK_OFF = "bg-slate-300 dark:bg-slate-600";
const KNOB = "inline-block h-4 w-4 rounded-full bg-white transition";

const { label, on, onChange }: Props = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={on}
  aria-label={label}
  onclick={() => onChange(!on)}
  class={`${TRACK} ${on ? TRACK_ON : TRACK_OFF}`}
>
  <span
    aria-hidden="true"
    class={`${KNOB} ${on ? "translate-x-4" : "translate-x-0.5"}`}
  ></span>
</button>
