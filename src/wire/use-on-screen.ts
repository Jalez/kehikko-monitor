import { useEffect, useState } from 'react'

/**
 * Whether this page is in front of the person: the host has it on screen (`kehikot.visible`,
 * protocol 2.45.0; a host before it says nothing, which is shown) and the window it is in is not
 * hidden or minimised (`document.hidden`).
 *
 * Monitor's page reads the host's traffic every second and its own server's health every five
 * seconds, and each read asks for a sample of every process on this computer. At This computer its
 * page is kept alive on every kehikko, so without this it read all day for a page nobody could see.
 * Off screen, both reads stop; they start again, with what was missed, when it is shown.
 */
export function onScreen(visible: boolean | undefined, hidden: boolean): boolean {
  return visible !== false && !hidden
}

const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden

export function useOnScreen(visible: boolean | undefined): boolean {
  const [hidden, setHidden] = useState(documentHidden)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const changed = () => setHidden(documentHidden())
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  return onScreen(visible, hidden)
}
