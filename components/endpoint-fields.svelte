<script lang="ts">
import type { City } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import { FiNavigation, FiSearch, MdSwapVert } from "../src/icons/glyphs";
import Icon from "./icon.svelte";
import LocationField from "./location-field.svelte";
import type { DestPrefill } from "./shell-types";

interface EndpointFieldsProps {
  city: City;
  startLabel: string | null;
  destLabel: string | null;
  startSet: boolean;
  destSet: boolean;
  hasLiveLocation: boolean;
  pickTarget: "start" | "dest" | null;
  // Candidates for a link's destination text that didn't resolve to one place.
  destPrefill: DestPrefill | null;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onSwap?: () => void;
}

// Without a swap this is a fragment; with one it is a box, since the button hangs on the seam.
const {
  city,
  startLabel,
  destLabel,
  startSet,
  destSet,
  hasLiveLocation,
  pickTarget,
  destPrefill,
  onStartSelect,
  onDestSelect,
  onStartClear,
  onDestClear,
  onUseCurrentLocation,
  onArmStart,
  onArmDest,
  onSwap,
}: EndpointFieldsProps = $props();
</script>

{#snippet fields()}
  <LocationField
    {city}
    label={startLabel}
    placeholder={hasLiveLocation ? "My location" : "Pick a starting point"}
    leadingIcon={FiNavigation}
    armed={pickTarget === "start"}
    canClear={startSet}
    clearLabel="Reset start to your location"
    pickLabel="Pick start on the map"
    onSelect={onStartSelect}
    onClear={onStartClear}
    onArmPick={onArmStart}
    currentLocationLabel={hasLiveLocation ? "My location" : null}
    {onUseCurrentLocation}
  />
  <LocationField
    {city}
    label={destLabel}
    placeholder="Where to?"
    leadingIcon={FiSearch}
    armed={pickTarget === "dest"}
    canClear={destSet}
    clearLabel="Clear destination"
    pickLabel="Pick destination on the map"
    onSelect={onDestSelect}
    onClear={onDestClear}
    onArmPick={onArmDest}
    prefill={destPrefill}
  />
{/snippet}

{#if onSwap === undefined}
  {@render fields()}
{:else}
  <!-- Hung half outside the boxes into the card padding, clear of each field's own buttons. -->
  <div class="relative space-y-2">
    {@render fields()}
    <button
      type="button"
      onclick={onSwap}
      aria-label="Swap start and destination"
      title="Swap start and destination"
      class="absolute top-1/2 right-0 z-10 grid h-7 w-7 -translate-y-1/2 translate-x-1/3 place-items-center rounded-full bg-white text-slate-500 shadow-md ring-1 ring-black/5 transition hover:text-slate-700 dark:bg-slate-700 dark:text-slate-300 dark:ring-white/10 dark:hover:text-white"
    >
      <Icon icon={MdSwapVert} class="h-4 w-4" aria-hidden="true" />
    </button>
  </div>
{/if}
