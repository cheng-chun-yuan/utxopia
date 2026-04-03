"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tracks which section is currently visible in the viewport using IntersectionObserver.
 * Updates the URL hash (debounced) and scrolls to the hash section on initial mount only.
 */
export function useActiveSection(sectionIds: string[]) {
  const [activeSection, setActiveSection] = useState(sectionIds[0] ?? "");
  const hasScrolledToHash = useRef(false);

  useEffect(() => {
    if (!hasScrolledToHash.current) {
      hasScrolledToHash.current = true;
      const hash = window.location.hash.slice(1);
      if (hash && sectionIds.includes(hash)) {
        setActiveSection(hash);
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: "smooth" });
      }
    }

    const observers: IntersectionObserver[] = [];
    const visibleSections = new Map<string, number>();

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (!el) continue;

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            visibleSections.set(id, entry.intersectionRatio);
          } else {
            visibleSections.delete(id);
          }

          let best: string | null = null;
          for (const sid of sectionIds) {
            if (visibleSections.has(sid)) {
              best = sid;
              break;
            }
          }
          if (best) setActiveSection(best);
        },
        { rootMargin: "-100px 0px -60% 0px", threshold: 0 }
      );
      observer.observe(el);
      observers.push(observer);
    }

    return () => observers.forEach((o) => o.disconnect());
  }, [sectionIds]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (activeSection) {
        window.history.replaceState(null, "", `#${activeSection}`);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [activeSection]);

  return activeSection;
}
