<script>
  import { Settings } from '@lucide/svelte'
  import logo from '../assets/dogs-logo-cropped.png'
  import { store } from '../lib/store.svelte.js'

  /** @type {{ onSettings: () => void }} */
  let { onSettings } = $props()

  const gpu = $derived(store.health?.comfy?.gpus?.[0])
  const comfyUp = $derived(!!store.health?.comfy?.up)
  const ICON_BTN = 'p-2 rounded-lg border border-white/5 hover:border-neon-red/40 hover:text-neon-red transition-colors'
</script>

<header class="flex items-center justify-between gap-3 px-4 py-3 2xl:px-6 2xl:py-4 border-b border-white/5 z-10">
  <div class="flex items-center gap-2.5 min-w-0">
    <img src={logo} alt="DOGS logo" class="w-8 h-8 2xl:w-12 2xl:h-12 object-contain" />
    <h1 class="text-lg 2xl:text-3xl font-bold tracking-wider">DOGS <span class="text-neon-red">AI</span></h1>
  </div>
  <div class="flex items-center gap-2 sm:gap-3 text-xs 2xl:text-base text-muted">
    <span class="hidden sm:flex items-center gap-1.5" title={store.connected ? 'Engine running' : 'Engine offline'}>
      <span class="w-2 h-2 rounded-full {store.connected ? 'bg-emerald-400' : 'bg-neon-red'}"></span> Engine
    </span>
    <span class="hidden sm:flex items-center gap-1.5" title={comfyUp ? 'ComfyUI running' : 'ComfyUI starts on the first generation'}>
      <span class="w-2 h-2 rounded-full {comfyUp ? 'bg-emerald-400' : 'bg-neutral-600'}"></span> ComfyUI
    </span>
    {#if gpu}
      <span class="hidden lg:inline truncate max-w-64">{gpu.name.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '')} · {gpu.vram_free_gb}/{gpu.vram_total_gb} GB</span>
    {/if}
    <button class={ICON_BTN} onclick={onSettings} title="Settings" aria-label="Settings"><Settings size={18} /></button>
  </div>
</header>
