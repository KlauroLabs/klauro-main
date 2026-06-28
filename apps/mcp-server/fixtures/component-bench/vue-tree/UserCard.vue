<template>
  <div class="card">{{ name }} — {{ email }}</div>
</template>

<script setup>
defineProps(['name', 'email'])
</script>
