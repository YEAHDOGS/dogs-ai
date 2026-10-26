// Save a Blob to the user's disk. Browsers and the Electron shell both handle <a download>: Electron shows its
// native "Save as" dialog. (Capacitor on Android/iOS would need @capacitor/filesystem + share instead.)
const REVOKE_MS = 60_000

/**
 * @param {Blob} blob
 * @param {string} name
 */
export function saveBlob(blob, name) {
  const href = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), REVOKE_MS)
}

/** "skyscrapers at dusk, cinematic" -> "skyscrapers-at-dusk-cinematic" (for file names). */
export const slug = (/** @type {string} */ s, max = 48) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'dogs-ai'
