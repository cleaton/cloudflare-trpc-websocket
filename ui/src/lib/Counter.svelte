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
  $: q2 = proxy.DO_COUNTER.count.subscribe(namespace, {
    onComplete: () => {
      console.log("COMPLETED")
    },
    onData: (v) => {
      count = v;
    },
  });
</script>

<p>Your namespace :: {_namespace}</p> 
<input type="text" bind:value={_namespace}/>
<p></p>
<button on:click={increment}>+</button>
<button on:click={decrement}>-</button>

<p>The counter is {count}</p>