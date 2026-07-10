import { readRecentControlActions } from '@/lib/telemetry';
import { buildDispatchCardData } from '@/lib/dispatch-card';

export async function GET() {
  const recent = readRecentControlActions();
  const data = buildDispatchCardData(recent, new Date());
  if (!data) {
    return Response.json({ error: 'No dispatch data available' }, { status: 503 });
  }
  return Response.json(data);
}
