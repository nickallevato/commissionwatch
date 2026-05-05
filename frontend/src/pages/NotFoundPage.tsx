import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="text-center py-12">
      <h2 className="text-2xl font-bold text-gray-100 mb-4">Page Not Found</h2>
      <p className="text-gray-400 mb-6">
        The page you're looking for doesn't exist.
      </p>
      <Link
        to="/"
        className="text-accent-400 hover:text-accent-300 font-medium"
      >
        Go back home
      </Link>
    </div>
  );
}
