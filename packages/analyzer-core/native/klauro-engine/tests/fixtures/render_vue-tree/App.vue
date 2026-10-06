<template>
  <div class="app">
    <UserCard :name="user.name" :email="user.email" />
  </div>
</template>

<script setup>
import UserCard from './UserCard.vue'

const user = { name: 'Ada', email: 'ada@x.com' }
</script>
