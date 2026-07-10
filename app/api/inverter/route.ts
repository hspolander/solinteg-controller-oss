import { readLiveInverterData } from '@/lib/inverter';

export async function GET() {
  const data = await readLiveInverterData();
  if (!data) {
    return Response.json({ error: 'No live data available' }, { status: 503 });
  }
  return Response.json(data);
}
