import React from 'react';
import { Outlet, useLocation } from 'react-router';
import Sidebar from './Sidebar';
import Header from './Header';

export const AppLayout: React.FC = () => {
  const location = useLocation();
  const isDashboard = location.pathname.startsWith('/dashboard');
  const shellClass = isDashboard ? 'app-shell app-shell-dashboard' : 'app-shell';

  return (
    <div className={shellClass} data-testid="app-shell">
      <Sidebar />
      <div className="app-main-viewport">
        <Header />
        <main className="app-content" data-testid="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
