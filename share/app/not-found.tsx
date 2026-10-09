// Also what the root path renders: this project serves share snapshots and
// nothing else, so trimming a link back to the domain reveals no app.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-base font-semibold">This link isn&rsquo;t available</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        It may have expired or been removed. Ask whoever sent it for a new one.
      </p>
    </main>
  );
}
