'use client';

import { useEffect, useState } from 'react';

// Whether this is the public demo, for client components deep in the tree.
// The root layout marks <html data-demo> server-side (from DEMO_MODE), so no
// prop has to be threaded through every caller. False until mounted, which
// keeps the server render and first client render identical.
export function useIsDemo(): boolean {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    setDemo(document.documentElement.dataset.demo === '1');
  }, []);
  return demo;
}
