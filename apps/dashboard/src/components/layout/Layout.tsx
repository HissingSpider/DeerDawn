import React from 'react';
import { useRouter } from 'next/router';
import { DashboardBootstrapProvider } from '@/components/dashboard/DashboardBootstrapProvider';
import { AppShell } from '@/components/dashboard/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const router = useRouter();
  return (
    <DashboardBootstrapProvider>
      <AppShell>
        {/*
          The routed page, and ONLY the routed page. The app's outer boundary in
          _app.tsx sits above ClerkProvider and Layout, so before this existed a
          throw in any single panel replaced the sidebar and every other route
          with a full-screen error — the user's way out was covered by the
          apology. This one is inside AppShell, so the nav survives a page
          crash and is clickable.

          `resetKey` is what makes that navigation work: a boundary holds its
          error until told otherwise, so keying on the route is what lets the
          next page render instead of inheriting the last one's crash. Scoping
          the boundary without it would leave a dead panel behind forever.
        */}
        <ErrorBoundary variant="inline" resetKey={router.asPath} label="dashboard_page">
          {children}
        </ErrorBoundary>
      </AppShell>
    </DashboardBootstrapProvider>
  );
};
