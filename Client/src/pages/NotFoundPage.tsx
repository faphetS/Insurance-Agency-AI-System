import { Link } from "react-router-dom";

const NotFoundPage = () => {
  return (
    <div className="min-h-dvh bg-neutral-300 flex flex-col items-center justify-center gap-6">
      <p className="text-6xl font-bold text-neutral-800">404</p>
      <p className="text-2xl text-neutral-700">Page not found</p>
      <Link
        to="/"
        className="px-6 py-3 rounded-xl bg-neutral-800 text-neutral-200 hover:bg-neutral-700 transition-colors"
      >
        Go Home
      </Link>
    </div>
  );
};

export default NotFoundPage;
