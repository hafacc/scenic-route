<script lang="ts">
import {
  type Factor,
  factorPercent,
  factorWeight,
  stepFor,
} from "../src/routing/factors";

interface Props {
  id?: string;
  factor: Factor;
  weight: number;
  disabled?: boolean;
  class?: string;
  onChange: (weight: number) => void;
}

const {
  id,
  factor,
  weight,
  disabled,
  class: className,
  onChange,
}: Props = $props();

const value = $derived(factorPercent(factor, weight));

function handleInput(
  event: Event & { currentTarget: EventTarget & HTMLInputElement },
): void {
  const input = event.currentTarget;
  onChange(factorWeight(factor, Number.parseInt(input.value, 10)));
  // A value the parent did not take snaps back to the weight's.
  if (input.value !== `${value}`) {
    input.value = `${value}`;
  }
}
</script>

<!-- A signed slider fills from the center, so `--pct` maps −100..100 to a 0..100 track. -->
<input
  {id}
  type="range"
  min={factor.signed ? -100 : 0}
  max={100}
  step={stepFor(factor)}
  {value}
  {disabled}
  oninput={handleInput}
  aria-label={factor.label}
  class={`scenery-slider ${className ?? ""}`}
  style="--fill:{factor.color};--pct:{factor.signed ? `${(value + 100) / 2}%` : `${value}%`}"
>
