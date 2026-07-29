import { useEffect, useState } from "react";
import { getApiHealth, type ApiHealth } from "../lib/apiClient";

export function useApiHealth(): ApiHealth | null {
  const [health, setHealth] = useState<ApiHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getApiHealth()
        .then((value) => {
          if (!cancelled) setHealth(value);
        })
        .catch(() => {
          if (!cancelled) setHealth(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return health;
}
