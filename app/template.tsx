import { PageResultProvider } from '@/app/_components/page-result';

// Mounted afresh on every navigation, unlike the root layout: whatever lives
// here belongs to one visit to one page. The page result line does
// (app/_components/page-result.tsx), so a result never outlives the page it
// describes.
export default function Template({ children }: { children: React.ReactNode }) {
  return <PageResultProvider>{children}</PageResultProvider>;
}
