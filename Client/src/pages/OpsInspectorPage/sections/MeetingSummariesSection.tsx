import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import api from "@/services/api";

interface MeetingRow {
  id: string;
  scheduled_at: string | null;
  status: string | null;
  summary_status: string | null;
  timeless_meeting_id: string | null;
  updated_at: string | null;
  transcript: string | null;
  summary_draft: string | null;
  summary_final: string | null;
  clients: { full_name: string } | null;
}

export function MeetingSummariesSection() {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["ops", "meeting-summaries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meetings")
        .select("id, scheduled_at, status, summary_status, timeless_meeting_id, updated_at, transcript, summary_draft, summary_final, clients(full_name)")
        .in("summary_status", ["draft", "approved", "sent"])
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as MeetingRow[];
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (meetingId: string) => {
      await api.post(`/operations/approve-summary/${meetingId}`, {});
    },
    onSuccess: () => {
      toast.success("Summary approved");
      void qc.invalidateQueries({ queryKey: ["ops", "meeting-summaries"] });
    },
    onError: () => {
      toast.error("Approval failed");
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
        Meetings with summary_status = draft/approved/sent. Click a row to expand transcript/summary.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No data yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-2 py-1 text-left">Client</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Scheduled At</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Status</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Summary Status</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Timeless ID</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Updated At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <>
                <tr
                  key={row.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                >
                  <td className="border border-gray-300 px-2 py-1">
                    {row.clients?.full_name ?? "—"}
                  </td>
                  <td className="border border-gray-300 px-2 py-1">
                    {row.scheduled_at ? new Date(row.scheduled_at).toLocaleString() : "—"}
                  </td>
                  <td className="border border-gray-300 px-2 py-1">{row.status ?? "—"}</td>
                  <td className="border border-gray-300 px-2 py-1">{row.summary_status ?? "—"}</td>
                  <td className="border border-gray-300 px-2 py-1 font-mono text-xs">
                    {row.timeless_meeting_id ? row.timeless_meeting_id.slice(0, 12) + "…" : "—"}
                  </td>
                  <td className="border border-gray-300 px-2 py-1">
                    {row.updated_at ? new Date(row.updated_at).toLocaleString() : "—"}
                  </td>
                </tr>
                {expandedId === row.id && (
                  <tr key={`${row.id}-expanded`}>
                    <td colSpan={6} className="border border-gray-300 bg-gray-50 px-3 py-3">
                      <div className="space-y-3">
                        <div>
                          <p className="text-xs font-bold mb-1">Transcript</p>
                          <pre className="text-xs bg-white border border-gray-200 p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                            {row.transcript ?? "(empty)"}
                          </pre>
                        </div>
                        <div>
                          <p className="text-xs font-bold mb-1">Summary Draft</p>
                          <pre className="text-xs bg-white border border-gray-200 p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                            {row.summary_draft ?? "(empty)"}
                          </pre>
                        </div>
                        <div>
                          <p className="text-xs font-bold mb-1">Summary Final</p>
                          <pre className="text-xs bg-white border border-gray-200 p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                            {row.summary_final ?? "(empty)"}
                          </pre>
                        </div>
                        {row.summary_status === "draft" && (
                          <button
                            className="bg-blue-600 text-white text-xs px-3 py-1 rounded disabled:opacity-50"
                            disabled={approveMutation.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              approveMutation.mutate(row.id);
                            }}
                          >
                            {approveMutation.isPending ? "Approving..." : "Approve"}
                          </button>
                        )}
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
