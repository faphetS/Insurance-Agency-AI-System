import { useQuery } from "@tanstack/react-query";
import api from "@/services/api";

interface ServiceMeetingClient {
  id: string;
  name: string;
  lastServiceDate: string | null;
  monthsSinceService: number | null;
  status: "due" | "upcoming" | "ok";
  latestMeetingSummaryStatus: string | null;
}

interface ServiceMeetingsResponse {
  clients: ServiceMeetingClient[];
  dueCount: number;
  upcomingCount: number;
  bafiConnected: boolean;
  lastBafiSync: null;
}

export function ServiceMeetingsSection() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["ops", "service-meetings"],
    queryFn: async () => {
      const res = await api.get<{ data: ServiceMeetingsResponse }>("/operations/service-meetings");
      return res.data.data;
    },
  });

  if (isLoading) return <p className="text-sm p-4">Loading...</p>;
  if (isError)
    return (
      <div className="p-4">
        <p className="text-sm text-red-600">Failed to load.</p>
        <button className="text-sm underline mt-1" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );

  const clients = data?.clients ?? [];
  const dueCount = data?.dueCount ?? 0;
  const upcomingCount = data?.upcomingCount ?? 0;
  const okCount = clients.length - dueCount - upcomingCount;

  return (
    <div className="p-4">
      <div className="flex gap-3 mb-4">
        <span className="bg-red-100 text-red-800 text-xs font-bold px-2 py-1 rounded">
          Due: {dueCount}
        </span>
        <span className="bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-1 rounded">
          Upcoming: {upcomingCount}
        </span>
        <span className="bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded">
          OK: {okCount}
        </span>
      </div>

      {clients.length === 0 ? (
        <p className="text-sm text-gray-500">No data yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left">Name</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Last Service Date</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Months Since</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td className="border border-gray-300 px-2 py-1">{c.name}</td>
                <td className="border border-gray-300 px-2 py-1">{c.lastServiceDate ?? "—"}</td>
                <td className="border border-gray-300 px-2 py-1">
                  {c.monthsSinceService !== null ? c.monthsSinceService.toFixed(1) : "—"}
                </td>
                <td className="border border-gray-300 px-2 py-1">{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
