'use client';

import { useEffect, useState } from 'react';
import Sidebar from './Sidebar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    try {
      if (localStorage.getItem('peacer-sidebar-collapsed') === '1') setCollapsed(true);
    } catch {}
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleToggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('peacer-sidebar-collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  };

  const sidebarW = !mounted ? 0 : isMobile ? 0 : collapsed ? 56 : 180;

  return (
    <>
      <Sidebar collapsed={collapsed} isMobile={isMobile} onToggleCollapsed={handleToggle} />
      <div style={{
        marginLeft: sidebarW,
        transition: 'margin-left .2s ease',
        minHeight: '100vh',
      }}>
        {children}
      </div>
    </>
  );
}
