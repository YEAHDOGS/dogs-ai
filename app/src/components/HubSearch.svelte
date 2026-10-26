<script>
  import { Search, ExternalLink, Download, ChevronDown, LoaderCircle, Lock } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import { api } from '../lib/api.js'
  import { store } from '../lib/store.svelte.js'
  import { size, count } from '../lib/format.js'
  import { EASE } from '../lib/motion.js'

  const INPUT = 'flex-1 min-w-0 bg-card border border-white/10 focus:border-neon-red/50 rounded-lg px-3 py-2 text-sm 2xl:text-lg outline-none'
  const BTN = 'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] 2xl:text-sm border border-white/10 hover:border-neon-red/50 hover:text-neon-red transition-colors disabled:opacity-40'
  const LIMIT = 15

  let query = $state('')
  let busy = $state(false)
  let error = $state('')
  /** @type {any[] | null} */ let results = $state(null)
  /** @type {Record<string, any>} */ let files = $state({})
  let open = $state('')

  async function search(/** @type {SubmitEvent} */ e) {
    e.preventDefault()
    busy = true
    error = ''
    try {
      results = await api(`/api/hub/search?kind=${store.kind}&limit=${LIMIT}&q=${encodeURIComponent(query)}`)
    } catch (err) {
      error = String(err.message || err)
    } finally {
      busy = false
    }
  }

  async function toggle(/** @type {string} */ repo) {
    open = open === repo ? '' : repo
    if (!open || files[repo]) return
    try { files[repo] = await api(`/api/hub/files?repo=${encodeURIComponent(repo)}`) } catch (err) { files[repo] = { error: String(err.message || err) } }
  }

  async function get(/** @type {string} */ repo, /** @type {string} */ file) {
    error = ''
    try { await api('/api/downloads', { method: 'POST', json: { target: repo, files: [file] } }) } catch (err) { error = String(err.message || err) }
  }
</script>

<div class="flex flex-col gap-2">
  <h3 class="text-xs 2xl:text-base uppercase tracking-wider text-muted">Search Hugging Face</h3>
  <form class="flex gap-2" onsubmit={search}>
    <input class={INPUT} bind:value={query} placeholder="{store.kind} models, e.g. flux, wan, ace-step" />
    <button class="px-3 rounded-lg border border-white/10 hover:border-neon-red/50" aria-label="Search">
      {#if busy}<LoaderCircle size={16} class="animate-spin" />{:else}<Search size={16} />{/if}
    </button>
  </form>
  {#if error}<p class="text-neon-red text-xs break-words">{error}</p>{/if}

  {#if results}
    {#if !results.length}<p class="text-xs text-muted">No matches.</p>{/if}
    {#each results as r (r.repo)}
      <div class="rounded-lg bg-card/40 border border-white/5 text-xs 2xl:text-sm" transition:slide={{ duration: 250, easing: EASE }}>
        <div class="flex items-center gap-2 p-2">
          <button class="flex-1 min-w-0 flex items-center gap-1.5 text-left" onclick={() => toggle(r.repo)}>
            <ChevronDown size={14} class="shrink-0 transition-transform duration-300 {open === r.repo ? 'rotate-180' : ''}" />
            <span class="truncate font-semibold">{r.repo}</span>
            {#if r.gated}<Lock size={12} class="shrink-0 text-amber-400" />{/if}
          </button>
          <span class="text-neutral-500 shrink-0">{count(r.downloads)} dl</span>
          <a class="shrink-0 hover:text-neon-red" href={r.url} target="_blank" rel="noopener noreferrer" aria-label="Open on Hugging Face"><ExternalLink size={14} /></a>
        </div>
        {#if r.family}<p class="px-2 pb-2 text-emerald-400">Built-in workflow: {r.family}</p>{/if}
        {#if open === r.repo}
          <div class="border-t border-white/5 p-2 flex flex-col gap-1" transition:slide={{ duration: 250, easing: EASE }}>
            {#if !files[r.repo]}
              <LoaderCircle size={14} class="animate-spin" />
            {:else if files[r.repo].error}
              <p class="text-neon-red break-words">{files[r.repo].error}</p>
            {:else if !files[r.repo].files.length}
              <p class="text-muted">No .safetensors / .gguf files (diffusers-format repos don't run in ComfyUI).</p>
            {:else}
              {#each files[r.repo].files as f (f.file)}
                <div class="flex items-center gap-2">
                  <a class="flex-1 min-w-0 truncate text-neutral-300 hover:text-neon-red" href={f.url} target="_blank" rel="noopener noreferrer" title={f.file}>{f.file}</a>
                  <span class="shrink-0 text-neutral-500">{size(f.size)}</span>
                  <button class={BTN} onclick={() => get(r.repo, f.file)} aria-label="Download {f.file}"><Download size={12} /></button>
                </div>
              {/each}
              <p class="text-neutral-600 mt-1">Files without a built-in workflow show under "unrecognized"; add a ComfyUI workflow in <code>workflows/</code> to use them.</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
