import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import api from "@/services/api";
import { supabase } from "@/lib/supabase";

interface TimelessStatus {
  webhookRegistered: boolean;
  lastEvent: string | null;
  lastPoll: string | null;
  [key: string]: unknown;
}

interface UnmatchedRow {
  id: string;
  timeless_meeting_id: string;
  start_time: string | null;
  host_email: string | null;
  reason: string | null;
  candidate_meeting_ids: string[];
}

interface RecentIngest {
  id: string;
  client_id: string | null;
  scheduled_at: string | null;
  timeless_meeting_id: string | null;
  updated_at: string | null;
}

function StatusPanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ops", "timeless-status"],
    queryFn: async () => {
      const res = await api.get<{ data: TimelessStatus }>("/integrations/timeless/status");
      return res.data.data;
    },
  });

  if (isLoading) return <p className="text-sm">Loading status...</p>;
  if (isError) return <p className="text-sm text-red-600">Failed to load status.</p>;

  return (
    <div className="mb-6">
      <h3 className="font-bold text-sm mb-2">Status</h3>
      <p className="text-xs text-gray-600 mb-1">
        Last event: {data?.lastEvent ?? "—"} | Last poll: {data?.lastPoll ?? "—"}
      </p>
      <pre className="text-xs bg-gray-50 border border-gray-200 p-2 overflow-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function UnmatchedPanel() {
  const qc = useQueryClient();
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState<Record<string, string>>({});

  const { data, isLoading, isError } = useQuery({
    queryKey: ["ops", "timeless-unmatched"],
    queryFn: async () => {
      const res = await api.get<{ data: UnmatchedRow[] }>("/integrations/timeless/unmatched");
      return res.data.data;
    },
  });

  const linkMutation = useMutation({
    mutationFn: async ({ id, meetingId }: { id: string; meetingId: string }) => {
      await api.post(`/integrations/timeless/unmatched/${id}/link`, { meeting_id: meetingId });
    },
    onSuccess: () => {
      toast.success("Linked successfully");
      void qc.invalidateQueries({ queryKey: ["ops", "timeless-unmatched"] });
    },
    onError: () => {
      toast.error("Link failed");
    },
  });

  if (isLoading) return <p className="text-sm">Loading unmatched...</p>;
  if (isError) return <p className="text-sm text-red-600">Failed to load unmatched.</p>;

  const rows = data ?? [];

  return (
    <div className="mb-6">
      <h3 className="font-bold text-sm mb-2">Unmatched ({rows.length})</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No unmatched meetings.</p>
      ) : (
        <table className="w-full text-sm border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left">Timeless ID</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Start Time</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Host Email</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Reason</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Candidates</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <>
                <tr key={row.id}>
                  <td className="border border-gray-300 px-2 py-1 font-mono text-xs">
                    {row.timeless_meeting_id.slice(0, 12)}…
                  </td>
                  <td className="border border-gray-300 px-2 py-1">
                    {row.start_time ? new Date(row.start_time).toLocaleString() : "—"}
                  </td>
                  <td className="border border-gray-300 px-2 py-1">{row.host_email ?? "—"}</td>
                  <td className="border border-gray-300 px-2 py-1">{row.reason ?? "—"}</td>
                  <td className="border border-gray-300 px-2 py-1">{row.candidate_meeting_ids.length}</td>
                  <td className="border border-gray-300 px-2 py-1">
                    <button
                      className="text-xs underline text-blue-600"
                      onClick={() => setOpenRowId(openRowId === row.id ? null : row.id)}
                    >
                      {openRowId === row.id ? "Hide" : "Link"}
                    </button>
                  </td>
                </tr>
                {openRowId === row.id && (
                  <tr key={`${row.id}-link`}>
                    <td colSpan={6} className="border border-gray-300 bg-gray-50 px-3 py-2">
                      <p className="text-xs font-bold mb-1">Candidate IDs:</p>
                      <ul className="text-xs font-mono mb-2 space-y-1">
                        {row.candidate_meeting_ids.map((cid) => (
                          <li key={cid}>
                            <button
                              className="underline text-blue-600"
                              onClick={() => setManualInput((prev) => ({ ...prev, [row.id]: cid }))}
                            >
                              {cid}
                            </button>
                          </li>
                        ))}
                      </ul>
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          className="border border-gray-300 text-xs px-2 py-1 rounded w-72 font-mono"
                          placeholder="UUID override"
                          value={manualInput[row.id] ?? ""}
                          onChange={(e) =>
                            setManualInput((prev) => ({ ...prev, [row.id]: e.target.value }))
                          }
                        />
                        <button
                          className="bg-blue-600 text-white text-xs px-3 py-1 rounded disabled:opacity-50"
                          disabled={!manualInput[row.id] || linkMutation.isPending}
                          onClick={() =>
                            linkMutation.mutate({ id: row.id, meetingId: manualInput[row.id] })
                          }
                        >
                          Submit
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RecentIngestsPanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ops", "timeless-recent"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meetings")
        .select("id, client_id, scheduled_at, timeless_meeting_id, updated_at")
        .not("timeless_meeting_id", "is", null)
        .order("updated_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as RecentIngest[];
    },
  });

  if (isLoading) return <p className="text-sm">Loading recent ingests...</p>;
  if (isError) return <p className="text-sm text-red-600">Failed to load recent ingests.</p>;

  const rows = data ?? [];

  return (
    <div>
      <h3 className="font-bold text-sm mb-2">Recent Ingests ({rows.length})</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No data yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left">Client ID</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Scheduled At</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Timeless ID</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Updated At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="border border-gray-300 px-2 py-1 font-mono text-xs">
                  {row.client_id ? row.client_id.slice(0, 8) + "…" : "—"}
                </td>
                <td className="border border-gray-300 px-2 py-1">
                  {row.scheduled_at ? new Date(row.scheduled_at).toLocaleString() : "—"}
                </td>
                <td className="border border-gray-300 px-2 py-1 font-mono text-xs">
                  {row.timeless_meeting_id ? row.timeless_meeting_id.slice(0, 12) + "…" : "—"}
                </td>
                <td className="border border-gray-300 px-2 py-1">
                  {row.updated_at ? new Date(row.updated_at).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function TimelessSection() {
  return (
    <div className="p-4">
      <StatusPanel />
      <UnmatchedPanel />
      <RecentIngestsPanel />
    </div>
  );
}
