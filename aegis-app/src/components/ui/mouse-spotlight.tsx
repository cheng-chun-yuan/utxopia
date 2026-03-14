"use client";

import { useEffect } from "react";

/**
 * Global mouse-tracking spotlight effect (like Aura/Maax).
 * Renders a fixed div that shows a radial gradient following the cursor.
 * Mount once in the root layout or page.
 */
export function MouseSpotlight() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = document.getElementById("mouse-spotlight");
      if (el) {
        el.style.setProperty("--mouse-x", `${e.clientX}px`);
        el.style.setProperty("--mouse-y", `${e.clientY}px`);
      }
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  return <div id="mouse-spotlight" />;
}
