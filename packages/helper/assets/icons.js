/** Shared current-color icons, ported from @deepseek-ai/dsh-client-ui-primitives. */

function svg(viewBox, size, markup, state) {
  const host = document.createElement('span')
  const stateAttr = state ? ` data-state="${state}"` : ''
  host.innerHTML = `<svg viewBox="${viewBox}" width="${size}" height="${size}" fill="none" aria-hidden="true"${stateAttr} stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`
  return host.firstElementChild
}

export function icon(markup, size = 14, viewBox = '0 0 16 16') {
  return svg(viewBox, size, markup)
}

export const THINK = '<path d="M10.7554 5.24466C13.9891 8.4783 15.3769 12.3333 13.8552 13.8551C12.3335 15.3768 8.4785 13.989 5.24478 10.7553C2.01111 7.52165 0.623307 3.66664 2.14504 2.14491C3.66676 0.623189 7.52178 2.01099 10.7554 5.24466Z" stroke="currentColor"></path><path d="M10.7554 10.7553C7.52178 13.989 3.66676 15.3768 2.14504 13.8551C0.623307 12.3333 2.01111 8.4783 5.24478 5.24466C8.4785 2.01099 12.3335 0.623189 13.8552 2.14491C15.3769 3.66664 13.9891 7.52165 10.7554 10.7553Z" stroke="currentColor"></path><path d="M8.9587 8.00025C8.9587 8.52835 8.5306 8.95655 8.0024 8.95655C7.47429 8.95655 7.04614 8.52835 7.04614 8.00025C7.04614 7.47209 7.47429 7.04395 8.0024 7.04395C8.5306 7.04395 8.9587 7.47209 8.9587 8.00025Z" fill="currentColor"></path>'
export const CHEVRON_DOWN = '<path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor"></path>'
export const CHEVRON_UP = '<path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor"></path>'
export const SEARCH = '<path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor"></path><path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor"></path>'
export const GLOBE = '<path d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z" stroke="currentColor"></path><path d="M2.34619 8H13.6538" stroke="currentColor" stroke-linecap="square"></path><path d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138" stroke="currentColor"></path><path d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138" stroke="currentColor"></path>'
export const BROWSE = '<path d="M4.9375 5.90295H11.0625" stroke="currentColor"></path><path d="M4.9375 9.02991H8.27841" stroke="currentColor"></path><path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z" fill="currentColor" stroke="none"></path>'
export const FOLDER = '<path d="M2.25 4.1C2.25 3.492 2.742 3 3.35 3H5.7C6.03 3 6.343 3.146 6.55 3.398L7.35 4.35H12.65C13.258 4.35 13.75 4.842 13.75 5.45V11.9C13.75 12.508 13.258 13 12.65 13H3.35C2.742 13 2.25 12.508 2.25 11.9V4.1Z" stroke="currentColor"></path>'
export const EDIT = '<path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" stroke="none"></path><path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor"></path>'
export const CODE = '<path d="M6.27612 1.5L4.52612 14.5" stroke="currentColor"></path><path d="M11.4739 1.5L9.72388 14.5" stroke="currentColor"></path><path d="M2.39868 5.5H14.0681" stroke="currentColor"></path><path d="M1.93188 10.5H13.6013" stroke="currentColor"></path>'
export const API = '<path d="M3 4L7 8L3 12" stroke="currentColor"></path><path d="M9 12H13" stroke="currentColor"></path>'
export const SPARKLE = '<path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z" stroke="currentColor"></path><path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z" stroke="currentColor"></path><path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z" stroke="currentColor"></path>'
export const CODE_BRACKETS = '<path d="M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494" stroke="currentColor"></path><path d="M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494" stroke="currentColor"></path><path d="M9.56222 3.62573L6.43774 12.3743" stroke="currentColor"></path>'
export const COPY = '<rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" stroke="currentColor"></rect><path d="M10.25 3.25H4.25C3.69772 3.25 3.25 3.69772 3.25 4.25V10.25" stroke="currentColor"></path>'
export const CHECK = '<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor"></path>'
export const CLOSE = '<path d="M4.5 4.5L11.5 11.5" stroke="currentColor"></path><path d="M11.5 4.5L4.5 11.5" stroke="currentColor"></path>'

/** StateDot ongoing spinner (viewBox 24), StateDot.tsx. */
export function stateSpinner() {
  const host = document.createElement('span')
  host.innerHTML = '<svg class="sdot-spinner" data-state="ongoing" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g class="sdot-motion"><circle class="sdot-track" cx="12" cy="12" r="9.5"></circle><circle class="sdot-arc" cx="12" cy="12" r="9.5"></circle></g></svg>'
  return host.firstElementChild
}

/** Solid 10px state dot — the glyph is painted by CSS (.sdot::after). */
export function stateDot(state) {
  const host = document.createElement('span')
  host.className = 'sdot'
  host.setAttribute('data-state', state)
  host.setAttribute('aria-hidden', 'true')
  return host
}
