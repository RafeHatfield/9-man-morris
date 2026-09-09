/**
 * `GET /api/game/[id]` — the public view of a room (GDD §7.3). This is what the
 * clients poll, and what a read-only visitor sees (GDD §6.4), so it needs no
 * token. Two separate things keep it fresh: `dynamic = 'force-dynamic'` for
 * Next's own caches, and the `Cache-Control: no-store` that `jsonResponse` puts
 * on every response these handlers produce, for HTTP ones.
 */

import { readRoom } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return readRoom(id);
}
