<template>
  <button @click="submit">{{ label }}</button>
</template>

<script setup lang="ts">
const label = 'Send'

function submit(payload: string): boolean {
  return payload.length > 0
}
</script>

<style scoped>
button { color: red; }
</style>
