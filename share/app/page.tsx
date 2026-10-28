import NotFound from './not-found';

// The domain's root is intentionally a dead end. Trimming a share link back
// to the host should reveal nothing about the ledger it came from.
export default function Home() {
  return <NotFound />;
}
