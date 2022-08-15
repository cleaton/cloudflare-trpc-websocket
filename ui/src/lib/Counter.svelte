<script lang="ts">
import {proxy} from "./trpc";
import type {proxyType} from "./trpc"
import { text } from "svelte/internal";
  const client: proxyType = proxy;
  $: _namespace = "yournamespace";
  $: namespace = { _namespace };
  $: q = {
    amount: 1,
    ...namespace,
  };
  $: count = 0;
  const increment = () => {
    client.DO_COUNTER.inc.mutate(q);
  };
  const decrement = () => {
    client.DO_COUNTER.dec.mutate(q);
  };
  let subscription;
  $: q2 = ((n) => {
    subscription?.unsubscribe()
    subscription = proxy.DO_COUNTER.count.subscribe(n, {
    onComplete: () => {
      console.log("COMPLETED")
    },
    onData: (v) => {
      count = v;
    },
  })
  })(namespace);
</script>

<p>Your namespace :: {_namespace}</p> 
<input type="text" bind:value={_namespace}/>
<p></p>
<button on:click={increment}>+</button>
<button on:click={decrement}>-</button>

<p>The counter is {count}</p>