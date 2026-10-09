import { revalidatePath } from 'next/cache';
import { resetDemo } from '@/db/demo-reset';
import { isDemoMode } from '@/lib/demo-mode';

// Daily demo reset, invoked by Vercel Cron with `Authorization: Bearer
// $CRON_SECRET`. Outside the demo the route does not exist.
export async function GET(request: Request): Promise<Response> {
  if (!isDemoMode()) return new Response('Not found', { status: 404 });
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const result = await resetDemo({
    DATABASE_URL: process.env.DATABASE_URL,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  });
  revalidatePath('/', 'layout');
  return Response.json(result);
}
