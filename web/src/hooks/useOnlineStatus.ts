import { useEffect, useState } from 'react';
import { pendingCount } from '../lib/db';

export function useOnlineStatus(): { online: boolean; pending: number } {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const refresh = () => {
      void pendingCount().then(setPending);
    };
    const on = () => {
      setOnline(true);
      refresh();
    };
    const off = () => setOnline(false);

    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    refresh();
    const interval = window.setInterval(refresh, 4000);

    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.clearInterval(interval);
    };
  }, []);

  return { online, pending };
}
