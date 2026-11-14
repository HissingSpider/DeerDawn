import Head from 'next/head';
import Link from 'next/link';

export default function Custom404() {
  return (
    <>
      <Head>
        <title>404 - Page Not Found | DeerDawn</title>
      </Head>
      <div className="flex min-h-screen items-center justify-center bg-background text-text-secondary">
        <div className="text-center">
          <h1 className="mb-4 text-[72px] font-bold">404</h1>
          <p className="mb-8 text-[18px] text-text-muted">
            Page not found
          </p>
          <Link href="/" className="inline-block rounded-md bg-primary px-6 py-3 font-semibold text-[#03120b] no-underline">
            Go back home
          </Link>
        </div>
      </div>
    </>
  );
}
