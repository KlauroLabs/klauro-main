<script lang="ts">
  import { derived } from "svelte/store";

  interface Props {
    label: string;
  }

  let { label }: Props = $props();

  function shout(value: string): string {
    return value.toUpperCase();
  }
</script>

<button class="loud">{shout(label)}</button>

<style>
  .loud {
    font-weight: bold;
  }
</style>
