<script lang="ts">
import { object } from 'zod';

  import { proxy } from './trpc'
  const namespace = {_namespace: "mycounter"}
  const q = {
      amount: 1,
      ...namespace
  }
  let count = proxy.DO_COUNTER.get.query(namespace)
  const increment = () => {
    count = proxy.DO_COUNTER.inc.mutate(q)
  }
  const decrement = () => {
    count = proxy.DO_COUNTER.dec.mutate(q)
  }
  let q2 = 0;
  let r = proxy.DO_COUNTER.count.subscribe(namespace, {
    onData: (v) => {
      if (v.type == "data") {
        q2 = v.data
      }
    },
  });
</script>

<button on:click={increment}>+</button>
<button on:click={decrement}>-</button>

{#await count}
	<p>...waiting for counter...</p>
{:then number}
	<p>The counter is {number}</p>
{:catch error}
	<p style="color: red">{error.message}</p>
{/await}