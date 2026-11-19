'use client';

import { createContext, useContext } from 'react';

const DemoContext = createContext(false);

export function DemoProvider({ demo, children }: { demo: boolean; children: React.ReactNode }) {
  return <DemoContext.Provider value={demo}>{children}</DemoContext.Provider>;
}

export function useIsDemo(): boolean {
  return useContext(DemoContext);
}
