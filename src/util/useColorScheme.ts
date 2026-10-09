import { useSyncExternalStore } from 'react'

const query = '(prefers-color-scheme: dark)'

function subscribe(cb: () => void) {
  const mq = window.matchMedia(query)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, () => (window.matchMedia(query).matches ? 'dark' : 'light'))
}
