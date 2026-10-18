'use client';
import { useEffect, useRef, useState } from 'react';

/** True while the element is (near) the viewport and the page is visible. Starts false until the observer reports. */
export function useOnScreen<T extends Element>(margin = '200px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const io = new IntersectionObserver(es => setInView(es.some(e => e.isIntersecting)), { rootMargin: margin });
    io.observe(el); return () => io.disconnect();
  }, [margin]);
  useEffect(() => {
    const on = () => setShown(!document.hidden); on();
    document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return [ref, inView && shown] as const;
}
