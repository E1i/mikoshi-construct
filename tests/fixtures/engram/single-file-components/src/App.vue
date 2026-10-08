<template>
  <p>import { fake } from './fake.ts'</p>
  <Badge />
</template>

<script setup lang="ts">
import { greet } from './greet.ts'
import Badge from './Badge.svelte'

greet('hall')
</script>
