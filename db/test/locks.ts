// Making a race deterministic (db/locks.dbtest.ts): a transaction on its own
// connection holds a lock one side needs partway through, and
// pg_stat_activity confirms a side is really waiting before it is released.
import postgres from 'postgres';

const url = () => process.env.DATABASE_URL as string;

// A transaction on its own connection that runs `statement` and holds
// whatever it locked until released.
export async function hold(statement: string) {
  const client = postgres(url(), { max: 1, prepare: false, onnotice: () => {} });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const done = client.begin(async (tx) => {
    await tx.unsafe(statement);
    locked();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await done;
    await client.end();
  };
}

// Wait until some backend is blocked on a lock while running a query that
// matches `pattern` (SQL ILIKE).
export async function waitForLockWait(pattern: string): Promise<void> {
  const observer = postgres(url(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    for (let i = 0; i < 200; i++) {
      const [{ n }] = await observer<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike ${pattern}`;
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`nothing waited on a lock running ${pattern}`);
  } finally {
    await observer.end();
  }
}

// Run `during` while `statement`'s lock is held, and release it whatever
// happens: a failed wait or assertion must not leave a table locked, or every
// later test times out behind it and the real failure is buried.
export async function whileHeld<T>(statement: string, during: () => Promise<T>): Promise<T> {
  const release = await hold(statement);
  try {
    return await during();
  } finally {
    await release();
  }
}
