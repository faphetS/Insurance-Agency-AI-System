import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";

interface StaffWithGmail {
  id: string;
  full_name: string | null;
  email: string | null;
  gmail_integrations: {
    is_active: boolean | null;
    last_unread_count: number | null;
    last_synced_at: string | null;
  } | null;
}

export function EmailStatusSection() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["ops", "email-status"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff")
        .select("id, full_name, email, gmail_integrations(is_active, last_unread_count, last_synced_at)")
        .eq("is_active", true)
        .order("full_name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as StaffWithGmail[];
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
  const apiDomain = env.VITE_API_DOMAIN;

  return (
    <div className="p-4">
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No staff found.</p>
      ) : (
        <table className="w-full text-sm border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left">Name</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Email</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Gmail Connected</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Unread</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Last Synced</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const gmail = row.gmail_integrations;
              const connected = gmail?.is_active === true;
              return (
                <tr key={row.id}>
                  <td className="border border-gray-300 px-2 py-1">{row.full_name ?? "—"}</td>
                  <td className="border border-gray-300 px-2 py-1">{row.email ?? "—"}</td>
                  <td className="border border-gray-300 px-2 py-1">{connected ? "Y" : "N"}</td>
                  <td className="border border-gray-300 px-2 py-1">
                    {gmail?.last_unread_count ?? "—"}
                  </td>
                  <td className="border border-gray-300 px-2 py-1">
                    {gmail?.last_synced_at
                      ? new Date(gmail.last_synced_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="border border-gray-300 px-2 py-1">
                    {!connected && (
                      <a
                        href={`${apiDomain}/api/integrations/gmail/authorize`}
                        className="text-blue-600 underline text-xs"
                      >
                        Connect Gmail
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
