/**
 * `/g/[roomId]` (GDD §5.1). The room id is the whole route; everything else —
 * the seat, the polling, the board — is the client's, since the server has no
 * idea which token this device holds.
 */

import { OnlineGame } from './OnlineGame';

export const dynamic = 'force-dynamic';

export default async function GamePage({ params }: PageProps<'/g/[roomId]'>) {
  const { roomId } = await params;
  return <OnlineGame roomId={roomId} />;
}
