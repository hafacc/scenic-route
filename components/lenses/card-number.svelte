<script lang="ts">
interface Props {
  index: number;
  color: string;
}

const { index, color }: Props = $props();
</script>

<span
  class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
  style="background-color:{color}"
  >{index + 1}</span
>
