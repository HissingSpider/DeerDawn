import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// clerkMiddleware() is what populates the auth context that getAuth(req) reads
// inside API route handlers; without it those routes cannot see the session.
// Passthrough mode — no routes are blocked; route protection lives in the client
// AuthProvider.
//
// This comment used to say app.deerdawn.com is a Clerk SATELLITE of deerdawn.com
// and that this file completes the __clerk_handshake. Both were stale: satellite
// was configured, broke (isSatellite moves Clerk's frontend API to
// clerk.app.deerdawn.com, which had no certificate), and was removed in 2922be41
// in May 2026. app.deerdawn.com is a SUBDOMAIN, so the production session cookie
// already spans both hosts and no handshake is involved. Left uncorrected it
// costs real debugging time — it sent a session down the satellite path while
// diagnosing a sign-in loop on 2026-08-28.
export default process.env.CLERK_SECRET_KEY
  ? clerkMiddleware()
  : function middleware() {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/api/:path*',
    '/trpc/:path*',
  ],
};
