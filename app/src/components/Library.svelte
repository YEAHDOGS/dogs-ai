<script>
  import { onMount } from 'svelte'
  import { store } from '../lib/store.svelte.js'
  import { buildTiles } from '../lib/library.js'
  import { size } from '../lib/format.js'
  import Section from './Section.svelte'
  import StorageBar from './StorageBar.svelte'
  import ModelTiles from './ModelTiles.svelte'
  import Generated from './Generated.svelte'
  import DownloadPanel from './DownloadPanel.svelte'
  import Converter from './Converter.svelte'

  const LLM_POLL_MS = 5000

  let downloadsOpen = $state(false)
  let modelsOpen = $state(false)
  let generatedOpen = $state(true)
  /** @type {any} */ let converting = $state(null)

  const tileCount = $derived(buildTiles(store.catalog, store.llm).length)

  // Keep "loaded / VRAM / context" live while the Library is open.
  onMount(() => {
    store.loadLlm().catch(() => {})
    const t = setInterval(() => store.loadLlm().catch(() => {}), LLM_POLL_MS)
    return () => clearInterval(t)
  })

  // Animate: open Create on Video with this image as the start frame.
  function animate(/** @type {any} */ it) {
    store.startFrame = { file: it.file, url: it.url }
    store.setKind('video')
    store.setView('create')
  }
</script>

<div class="flex flex-col gap-3 2xl:gap-5 max-w-7xl 2xl:max-w-none mx-auto w-full">
  <Section title="Download models" bind:open={downloadsOpen}>
    {#snippet summary()}Hugging Face{/snippet}
    <DownloadPanel />
  </Section>

  <Section title="Models" bind:open={modelsOpen}>
    {#snippet summary()}{tileCount} · {size((store.catalog.storage?.bytes || 0) + (store.llm.disk?.bytes || 0))}{/snippet}
    {#snippet peek()}
      <div class="flex flex-col gap-4">
        <StorageBar />
        <ModelTiles expanded={modelsOpen} />
      </div>
    {/snippet}
    {#if tileCount}<p class="text-[11px] 2xl:text-sm text-neutral-600">Context windows show configured / model maximum. Hover a tile to delete it.</p>{/if}
  </Section>

  <Section title="Generated" bind:open={generatedOpen}>
    {#snippet summary()}{store.media.length} items{/snippet}
    <Generated onConvert={(it) => (converting = it)} onAnimate={animate} />
  </Section>
</div>

{#if converting}<Converter item={converting} onClose={() => (converting = null)} />{/if}
