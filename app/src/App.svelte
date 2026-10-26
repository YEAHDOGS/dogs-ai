<script>
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { store } from './lib/store.svelte.js'
  import { glide, PAGE_MS } from './lib/motion.js'
  import { AutoHeight } from './lib/autoHeight.svelte.js'
  import Header from './components/Header.svelte'
  import NavBar from './components/NavBar.svelte'
  import KindSwitch from './components/KindSwitch.svelte'
  import Composer from './components/Composer.svelte'
  import ModelHelp from './components/ModelHelp.svelte'
  import Gallery from './components/Gallery.svelte'
  import Library from './components/Library.svelte'
  import Preview from './components/Preview.svelte'
  import Settings from './components/Settings.svelte'
  import Offline from './components/Offline.svelte'

  // Pages stack in one grid cell while they cross-fade, so the outgoing page never pushes the incoming one.
  const STACK = 'col-start-1 row-start-1 min-w-0'
  const FILL = 'grid grid-rows-[minmax(0,1fr)] grid-cols-[minmax(0,1fr)]'
  // A pane's height eases to its incoming page (see lib/autoHeight). Taller outgoing pages are clipped while
  // they fade, so only the incoming height reaches the scroll container and its scrollbar.
  const PANE = 'grid grid-cols-[minmax(0,1fr)] items-start overflow-y-clip'
  const VIEW_SHIFT_PX = 96
  const asideHeight = new AutoHeight()
  const galleryHeight = new AutoHeight()

  let showSettings = $state(false)

  onMount(() => { store.connect() })
</script>

<main class="h-dvh w-full flex flex-col bg-app text-white overflow-hidden relative">
  <div class="absolute inset-0 bg-radial-[ellipse_at_top_right] from-neon-red/8 to-transparent to-50% pointer-events-none"></div>

  <Header onSettings={() => (showSettings = true)} />

  <div class="flex-1 min-h-0 {FILL} z-10">
    {#if !store.connected}
      <div class="{STACK} flex" transition:fade={{ duration: PAGE_MS / 2 }}>
        <Offline onSettings={() => (showSettings = true)} />
      </div>
    {:else}
      <div class="{STACK} min-h-0 flex flex-col md:flex-row" transition:fade={{ duration: PAGE_MS / 2 }}>
        <NavBar />
        <div class="flex-1 min-h-0 {FILL} overflow-x-hidden">
          {#key store.view}
            <div class="{STACK} min-h-0 {FILL}" in:glide={{ dir: store.viewDir, distance: VIEW_SHIFT_PX }} out:glide={{ dir: -store.viewDir, distance: VIEW_SHIFT_PX }}>
              {#if store.view === 'library'}
                <div class="min-h-0 overflow-y-auto overflow-x-hidden p-4 2xl:p-6"><Library /></div>
              {:else}
                <div class="min-h-0 overflow-y-auto overflow-x-hidden md:overflow-hidden flex flex-col md:flex-row">
                  <aside class="w-full md:w-80 lg:w-96 2xl:w-[32rem] shrink-0 md:overflow-y-auto overflow-x-hidden border-b md:border-b-0 md:border-r border-white/5 p-4 2xl:p-6 flex flex-col gap-4">
                    <KindSwitch />
                    <div class={PANE} style={asideHeight.style}>
                      {#key `${store.kind}:${!store.ready.length}`}
                        <div class={STACK} in:glide={{ dir: store.dir }} out:glide={{ dir: -store.dir }} {@attach asideHeight.track}>
                          {#if !store.ready.length}
                            <ModelHelp onClose={null} />
                          {:else}
                            <Composer />
                          {/if}
                        </div>
                      {/key}
                    </div>
                  </aside>
                  <section class="flex-1 min-w-0 md:overflow-y-auto overflow-x-hidden p-4 2xl:p-6">
                    <div class={PANE} style={galleryHeight.style}>
                      {#key store.kind}
                        <div class={STACK} in:glide={{ dir: store.dir, distance: 72 }} out:glide={{ dir: -store.dir, distance: 72 }} {@attach galleryHeight.track}>
                          <Gallery />
                        </div>
                      {/key}
                    </div>
                  </section>
                </div>
              {/if}
            </div>
          {/key}
        </div>
      </div>
    {/if}
  </div>

  <Preview />
  {#if showSettings}<Settings onClose={() => (showSettings = false)} />{/if}
</main>
