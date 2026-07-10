import { fetchSolarForecast } from '@/lib/forecast';
import { getSolarProfileByMonth } from '@/lib/solar';

// Returns 15-min solar forecast for today + tomorrow.
// Falls back to static monthly averages (24 hourly values) if forecast is unavailable.
export async function GET() {
  try {
    const forecast = await fetchSolarForecast();
    return Response.json({ source: 'forecast', forecast });
  } catch {
    const month = new Date().getMonth() + 1;
    return Response.json({
      source: 'typical',
      month,
      hourlyKwh: getSolarProfileByMonth(month),
    });
  }
}
