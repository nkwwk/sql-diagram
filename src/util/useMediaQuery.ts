import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Phone-sized layout. */
export const useIsNarrow = () => useMediaQuery('(max-width: 640px)')
/** Primary input is a finger (no hover, no drag and drop). */
export const useIsTouch = () => useMediaQuery('(pointer: coarse)')
