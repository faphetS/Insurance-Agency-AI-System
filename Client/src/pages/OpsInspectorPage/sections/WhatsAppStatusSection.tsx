import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

interface WhatsAppInstanceRow {
  id: string;
  label: string | null;
  phone_number: string | null;
  is_connected: boolean | null;
  last_unanswered_count: number | null;
  last_synced_at: string | null;
  staff: { full_name: string } | null;
}

export function WhatsAppStatusSection() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["ops", "whatsapp-status"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_instances")
        .select("id, label, phone_number, is_connected, last_unanswered_count, last_synced_at, staff(full_name)")
        .order("label", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as WhatsAppInstanceRow[];
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

  const rows = data ?? [];

  return (
    <div className="p-4">
      <p className="text-xs text-gray-500 mb-3">
        GreenAPI provisioning happens externally — no connect button.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No WhatsApp instances found.</p>
      ) : (
        <table className="w-full text-sm border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left">Label</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Staff</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Phone</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Connected</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Unanswered</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Last Synced</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="border border-gray-300 px-2 py-1">{row.label ?? "—"}</td>
                <td className="border border-gray-300 px-2 py-1">
                  {row.staff?.full_name ?? "—"}
                </td>
                <td className="border border-gray-300 px-2 py-1">{row.phone_number ?? "—"}</td>
                <td className="border border-gray-300 px-2 py-1">
                  {row.is_connected ? "Y" : "N"}
                </td>
                <td className="border border-gray-300 px-2 py-1">
                  {row.last_unanswered_count ?? "—"}
                </td>
                <td className="border border-gray-300 px-2 py-1">
                  {row.last_synced_at
                    ? new Date(row.last_synced_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
