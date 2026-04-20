'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';

type NavItem = {
  href: string;
  label: string;
  icon: string;
};

const NAV: NavItem[] = [
  { href: '/', label: '타임라인', icon: '◐' },
  { href: '/lead-times', label: '리드타임', icon: '◑' },
];

export default function Sidebar({
  collapsed,
  isMobile,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  isMobile: boolean;
  onToggleCollapsed: () => void;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const width = collapsed ? 56 : 180;

  // Mobile: hamburger + overlay
  if (isMobile) {
    return (
      <>
        <button
          onClick={() => setMobileOpen(true)}
          style={{
            position: 'fixed', top: 10, left: 10, zIndex: 150,
            width: 36, height: 36, borderRadius: 8,
            background: '#FFF', border: '1px solid #E5E8EB',
            fontSize: 18, color: '#4E5968', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="메뉴"
        >☰</button>

        {mobileOpen && (
          <>
            <div
              onClick={() => setMobileOpen(false)}
              style={{
                position: 'fixed', inset: 0, zIndex: 199,
                background: 'rgba(26,22,19,.4)',
              }}
            />
            <nav style={{
              position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 200,
              width: 220, background: '#FFF',
              borderRight: '1px solid #E5E8EB',
              padding: '16px 10px', display: 'flex', flexDirection: 'column', gap: 4,
              boxShadow: '2px 0 12px rgba(0,0,0,.08)',
            }}>
              <div style={{
                fontSize: 14, fontWeight: 700, color: '#1A1613',
                padding: '4px 10px 14px', letterSpacing: '-0.01em',
              }}>PEACER</div>
              {NAV.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 8,
                    background: pathname === item.href ? '#EFEBFA' : 'transparent',
                    color: pathname === item.href ? '#5F4B82' : '#4E5968',
                    fontSize: 13, fontWeight: pathname === item.href ? 600 : 500,
                    textDecoration: 'none',
                  }}
                >
                  <span style={{ fontSize: 14, width: 16, textAlign: 'center' }}>{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </nav>
          </>
        )}
      </>
    );
  }

  return (
    <aside style={{
      position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 100,
      width, background: '#FFF',
      borderRight: '1px solid #E5E8EB',
      padding: '16px 8px',
      display: 'flex', flexDirection: 'column', gap: 4,
      transition: 'width .2s ease',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between',
        padding: '4px 8px 14px',
      }}>
        {!collapsed && (
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.01em' }}>
            PEACER
          </span>
        )}
        <button
          onClick={onToggleCollapsed}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#8B95A1', fontSize: 14, padding: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label={collapsed ? '펼치기' : '접기'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {NAV.map(item => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: collapsed ? '10px 0' : '10px 12px',
              justifyContent: collapsed ? 'center' : 'flex-start',
              borderRadius: 8,
              background: active ? '#EFEBFA' : 'transparent',
              color: active ? '#5F4B82' : '#4E5968',
              fontSize: 13, fontWeight: active ? 600 : 500,
              textDecoration: 'none',
              transition: 'background .15s',
            }}
          >
            <span style={{ fontSize: 15, width: 16, textAlign: 'center' }}>{item.icon}</span>
            {!collapsed && item.label}
          </Link>
        );
      })}
    </aside>
  );
}
