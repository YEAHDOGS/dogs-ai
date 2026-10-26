<script>
  import { Sparkles, Library, Image, Clapperboard, AudioLines } from '@lucide/svelte'
  import { fly, fade } from 'svelte/transition'
  import { store, KINDS, VIEWS } from '../lib/store.svelte.js'
  import { EASE } from '../lib/motion.js'
  import SwapText from './SwapText.svelte'

  const HOLD_MS = 320
  const PICKER_STAGGER_MS = 45
  const BUZZ_MS = 8
  const VIEW_ICONS = { create: Sparkles, library: Library }
  const KIND_ICONS = { image: Image, video: Clapperboard, audio: AudioLines }
  const TABS = VIEWS.filter((v) => v.id in VIEW_ICONS)

  const index = $derived(Math.max(0, TABS.findIndex((t) => t.id === store.view)))
  const kindLabel = $derived(KINDS.find((k) => k.id === store.kind)?.label || '')

  let pickerOpen = $state(false)
  let hovered = $state('')
  let holdTimer = 0
  let held = false
  let slid = false

  const buzz = () => navigator.vibrate?.(BUZZ_MS)

  function choose(/** @type {string} */ kind) {
    store.setKind(kind)
    store.setView('create')
    pickerOpen = false
    hovered = ''
  }

  // Press: start the hold timer. Hold long enough and the picker slides up under your finger.
  function down(/** @type {PointerEvent} */ e) {
    if (e.button !== 0) return
    held = false
    slid = false
    // Capture keeps move/up events coming to this button while the finger slides over the picker.
    try { /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId) } catch {}
    holdTimer = setTimeout(() => { held = true; pickerOpen = true; buzz() }, HOLD_MS)
  }

  // While held: whatever kind is under the pointer lights up.
  function move(/** @type {PointerEvent} */ e) {
    if (!pickerOpen || !held) return
    const el = /** @type {HTMLElement | null} */ (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-kind]'))
    const kind = el?.dataset.kind || ''
    if (kind && kind !== hovered) { buzz(); slid = true }
    hovered = kind
  }

  // Release: on a kind -> pick it. Held but released in place -> leave the picker open to tap.
  // A quick tap -> go to Create (or toggle the picker when already there).
  function up() {
    clearTimeout(holdTimer)
    if (held) {
      if (hovered) choose(hovered)
      else if (slid) pickerOpen = false
      held = false
      return
    }
    if (store.view === 'create') pickerOpen = !pickerOpen
    else store.setView('create')
  }

  function cancel() {
    clearTimeout(holdTimer)
    held = false
  }

  function onKey(/** @type {KeyboardEvent} */ e) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (e.key === 'Escape') pickerOpen = false
    if (!step) return
    e.preventDefault()
    store.setView(TABS[(index + step + TABS.length) % TABS.length].id)
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (pickerOpen = false)} />

{#if pickerOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px]" transition:fade={{ duration: 180 }} onclick={() => (pickerOpen = false)}></div>
{/if}

<!-- Bottom bar on phones, side rail from md up. One pill slides under the active tab. -->
<nav class="nav order-last md:order-first border-t md:border-t-0 md:border-r border-white/5 bg-app/80 backdrop-blur-md p-2 md:p-3 z-40">
  <div class="relative flex md:flex-col" role="tablist" aria-label="Sections" tabindex="-1" onkeydown={onKey} style="--i: {index}; --n: {TABS.length}">
    <span class="pill" aria-hidden="true"></span>
    {#each TABS as t (t.id)}
      {@const Icon = VIEW_ICONS[t.id]}
      {@const active = store.view === t.id}
      {#if t.id === 'create'}
        <div class="relative flex flex-1 md:flex-none">
          {#if pickerOpen}
            <!-- Slides up from the Create button (out to the right on the side rail) -->
            <div class="picker absolute z-50 flex flex-col gap-1.5 p-1.5 rounded-2xl bg-card/95 border border-white/10 shadow-2xl" role="menu" aria-label="Create">
              {#each KINDS as k, i (k.id)}
                {@const KIcon = KIND_ICONS[k.id]}
                <button
                  data-kind={k.id}
                  role="menuitem"
                  class="kind flex items-center gap-3 px-4 py-3 2xl:px-6 2xl:py-4 rounded-xl text-sm 2xl:text-lg font-semibold whitespace-nowrap"
                  class:hot={hovered === k.id}
                  class:current={store.kind === k.id}
                  in:fly={{ y: 16, duration: 380, delay: (KINDS.length - 1 - i) * PICKER_STAGGER_MS, easing: EASE }}
                  out:fade={{ duration: 120 }}
                  onpointerenter={() => (hovered = k.id)}
                  onpointerleave={() => !held && (hovered = '')}
                  onclick={() => choose(k.id)}
                >
                  <KIcon size={20} /> {k.label}
                </button>
              {/each}
            </div>
          {/if}
          <button
            class="tab relative z-10 flex flex-1 flex-col items-center justify-center gap-1 py-2 md:w-20 md:h-20 2xl:w-28 2xl:h-28 text-[11px] 2xl:text-base touch-none select-none"
            class:active
            role="tab"
            aria-selected={active}
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            title="Tap to create · hold to pick image, video or audio"
            onpointerdown={down}
            onpointermove={move}
            onpointerup={up}
            onpointercancel={cancel}
            oncontextmenu={(e) => e.preventDefault()}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), up())}
          >
            <span class="icon"><Icon size={22} /></span>
            <span class="font-semibold tracking-wide">{t.label}</span>
            <SwapText text={kindLabel} class="text-[9px] 2xl:text-sm opacity-60" />
          </button>
        </div>
      {:else}
        <button
          class="tab relative z-10 flex flex-1 md:flex-none flex-col items-center justify-center gap-1 py-2 md:w-20 md:h-20 2xl:w-28 2xl:h-28 text-[11px] 2xl:text-base"
          class:active
          role="tab"
          aria-selected={active}
          onclick={() => store.setView(t.id)}
        >
          <span class="icon"><Icon size={22} /></span>
          <span class="font-semibold tracking-wide">{t.label}</span>
          <SwapText text={`${store.media.length} items`} class="text-[9px] 2xl:text-sm opacity-60" />
        </button>
      {/if}
    {/each}
  </div>
</nav>

<style>
  .nav {
    animation: slide-up-fade 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes slide-up-fade {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
  }

  .pill {
    position: absolute;
    top: 0;
    left: 0;
    width: calc(100% / var(--n));
    height: 100%;
    border-radius: 0.875rem;
    background: rgb(255 51 68 / 14%);
    border: 1px solid rgb(255 51 68 / 35%);
    box-shadow: 0 0 20px rgb(255 51 68 / 25%), inset 0 1px 0 rgb(255 255 255 / 8%);
    transform: translateX(calc(var(--i) * 100%));
    transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* Picker above the button on the bottom bar */
  .picker {
    bottom: calc(100% + 0.75rem);
    left: 50%;
    translate: -50% 0;
    transform-origin: bottom center;
  }

  @media (min-width: 48rem) {
    .pill {
      width: 100%;
      height: calc(100% / var(--n));
      transform: translateY(calc(var(--i) * 100%));
    }

    /* ...and out to the right of it on the side rail */
    .picker {
      bottom: auto;
      top: 0;
      left: calc(100% + 0.75rem);
      translate: 0 0;
    }
  }

  .tab {
    color: var(--color-muted);
    border-radius: 0.875rem;
    transition: color 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    -webkit-touch-callout: none;
  }

  .tab:hover {
    color: #fff;
  }

  .tab.active {
    color: var(--color-neon-red);
    text-shadow: 0 0 8px rgb(255 51 68 / 45%);
  }

  .icon {
    display: flex;
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .tab:hover .icon {
    transform: translateY(-3px) scale(1.08);
  }

  .tab:active .icon {
    transform: translateY(-1px) scale(0.96);
  }

  .tab.active .icon {
    transform: translateY(-2px) scale(1.12);
    filter: drop-shadow(0 0 6px rgb(255 51 68 / 60%));
  }

  .kind {
    color: #d4d4d8;
    border: 1px solid transparent;
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.2s, color 0.2s, border-color 0.2s;
  }

  .kind.current {
    color: var(--color-neon-red);
  }

  .kind.hot {
    color: #fff;
    background: rgb(255 51 68 / 22%);
    border-color: rgb(255 51 68 / 50%);
    box-shadow: 0 0 18px rgb(255 51 68 / 30%);
    transform: scale(1.06);
  }

  @media (prefers-reduced-motion: reduce) {
    .nav,
    .pill,
    .icon,
    .kind {
      animation: none;
      transition: none;
    }
  }
</style>
