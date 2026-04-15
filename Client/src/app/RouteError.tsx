import { useRouteError } from "react-router-dom";

export function RouteError() {
  const err = useRouteError();
  const message = err instanceof Error ? err.message : String(err);

  const isChunkError =
    /Failed to fetch dynamically imported module|ChunkLoadError|Loading chunk/i.test(
      message,
    );

  if (isChunkError) {
    const key = "__chunk_reload_attempted";
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      window.location.reload();
      return null;
    }
  }

  return (
    <div
      className="min-h-dvh bg-slate-950 text-slate-100 flex items-center justify-center p-6"
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      <div className="max-w-lg w-full flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Something went wrong.
          </h1>
          <p className="text-slate-400 text-sm">
            An unexpected error occurred. You can try reloading the page or
            return to the home screen.
          </p>
        </div>

        <code className="block bg-slate-900 border border-white/5 text-rose-300 font-mono text-xs p-3 rounded-lg break-all whitespace-pre-wrap">
          {message}
        </code>

        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-medium transition-colors"
          >
            Reload
          </button>
          <a
            href="/"
            className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 text-slate-300 text-sm font-medium transition-colors"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
