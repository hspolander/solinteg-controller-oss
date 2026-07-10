import { fetchPrices } from '@/lib/prices';

export async function GET() {
  try {
    const data = await fetchPrices();
    return Response.json(data, {
      headers: { 'Cache-Control': `private, max-age=${data.maxAge}` },
    });
  } catch {
    return Response.json({ error: 'Failed to fetch prices' }, { status: 502 });
  }
}
